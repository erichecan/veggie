import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth, tryAuth, effectiveRoles } from '@/lib/auth'
import { sendOrderConfirmation } from '@/lib/email'
import { resolveOrderLines, toOrderItems } from '@/lib/server-pricing'
import { toNum } from '@/lib/decimal-helpers'
import { serializeApi } from '@/lib/api-serializer'
import { deriveOrderItemsList } from '@/lib/order-items'
import { getOrderWaveDisplayMap } from '@/lib/wave-assign'

// SSOT: 调度归属显示一律由「所属 wave + 实时 DriverSlot」派生(P0-1)。
// formatDriverSlotFromOrder 优先读 deliveryBatchDisplay,故在此注入即全站统一,无需改各页。
async function attachWaveDisplay<T extends { id: string; deliveryBatchDisplay?: string | null }>(orders: T[]): Promise<T[]> {
  const map = await getOrderWaveDisplayMap(orders.map((o) => o.id))
  for (const o of orders) {
    if (map[o.id]) o.deliveryBatchDisplay = map[o.id]
  }
  return orders
}

// 只读展示兼容层：salesUser 关联展平成 salesman 字符串,方便旧的只读页面(报表/打印/列表)
// 不用改动就能继续显示业务员姓名。写入路径一律走 salesUserId,不读这个字段。
function attachSalesmanDisplay<T extends { salesUser?: { id: string; name: string } | null }>(orders: T[]): (T & { salesman: string | null })[] {
  return orders.map((o) => ({ ...o, salesman: o.salesUser?.name ?? null }))
}
import type { $Enums } from '@/lib/generated/prisma/client'
import { getInitials, nextOrderCode } from '@/lib/order-code'

const ORDER_STATUSES = new Set<$Enums.OrderStatus>([
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED',
])
const PAYMENT_METHODS = new Set<$Enums.PaymentMethod>(['ONLINE', 'CASH'])

function normalizeStatus(raw: unknown): $Enums.OrderStatus {
  const u = String(raw ?? 'PENDING').toUpperCase() as $Enums.OrderStatus
  return ORDER_STATUSES.has(u) ? u : 'PENDING'
}
function normalizePaymentMethod(raw: unknown): $Enums.PaymentMethod {
  const u = String(raw ?? 'ONLINE').toUpperCase() as $Enums.PaymentMethod
  return PAYMENT_METHODS.has(u) ? u : 'ONLINE'
}

function normalizeDateOnly(raw: unknown): Date | undefined {
  if (!raw) return undefined
  const s = String(raw).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined
  return new Date(s + 'T00:00:00Z')
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const restaurantId = searchParams.get('restaurantId')
    // ?restaurantIds=id1,id2,id3 — multi-customer filter (used by print reports)
    const restaurantIdsParam = searchParams.get('restaurantIds')
    const restaurantIds = restaurantIdsParam ? restaurantIdsParam.split(',').filter(Boolean) : null
    // ?ids=id1,id2,id3 — explicit order id filter (used by print center, driven off wave.orderIds)
    const idsParam = searchParams.get('ids')
    const ids = idsParam ? idsParam.split(',').filter(Boolean) : null
    const includeLines = searchParams.get('include_lines') !== 'false'

    // ?status=PENDING or ?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED
    const statusParam = searchParams.get('status')
    const statusFilter = statusParam
      ? statusParam.split(',').map(s => s.trim().toUpperCase()).filter(s => ORDER_STATUSES.has(s as $Enums.OrderStatus)) as $Enums.OrderStatus[]
      : null

    // ?search= → match restaurantName or code (case-insensitive)
    const search = searchParams.get('search')?.trim() ?? ''

    // ?fromDate=2026-04-01 ?toDate=2026-05-15 — date range filter
    // ?dateField=deliveryDate|quotationDate|createdAt (default: createdAt)
    const fromDate = searchParams.get('fromDate')
    const toDate = searchParams.get('toDate')
    const dateField = searchParams.get('dateField') ?? 'createdAt'
    const allowedDateFields = new Set(['createdAt', 'deliveryDate', 'quotationDate'])

    // ?page= & ?pageSize= → server-side pagination (pageSize=0 or absent → legacy flat array)
    const rawPageSize = parseInt(searchParams.get('pageSize') ?? '0', 10)
    const paginated = rawPageSize > 0
    const pageSize = paginated ? Math.min(200, Math.max(1, rawPageSize)) : 0
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

    const where: Record<string, unknown> = {}
    if (restaurantId) where.restaurantId = restaurantId
    if (restaurantIds && restaurantIds.length > 0) where.restaurantId = { in: restaurantIds }
    if (ids && ids.length > 0) where.id = { in: ids }
    if (statusFilter && statusFilter.length > 0) where.status = { in: statusFilter }
    if (search) {
      where.OR = [
        { restaurantName: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (fromDate || toDate) {
      const field = allowedDateFields.has(dateField) ? dateField : 'createdAt'
      const range: Record<string, Date> = {}
      if (fromDate) range.gte = new Date(fromDate + 'T00:00:00Z')
      if (toDate) range.lte = new Date(toDate + 'T23:59:59Z')
      where[field] = range
    }

    // deliveryBatch 字符串已弃用(调度归属归 wave,P0-1);按批次筛选用 driverSlotId
    const driverSlotId = searchParams.get('driverSlotId')
    if (driverSlotId) where.driverSlotId = driverSlotId

    // ?salesUserId=xxx — filter by salesperson
    const salesUserId = searchParams.get('salesUserId')
    if (salesUserId) where.salesUserId = salesUserId

    // P1-3: SALES 角色自动过滤 — 只看自己名下的订单
    if (!salesUserId) {
      const caller = await tryAuth(req)
      if (caller) {
        const roles = effectiveRoles(caller)
        if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
          where.salesUserId = caller.userId
        }
      }
    }

    // ?categoryId=xxx — filter orders that have at least one line with product in this category
    const categoryId = searchParams.get('categoryId')
    if (categoryId) {
      where.lines = { some: { product: { categoryId } } }
    }

    // 列表页表头下的"列筛选框"(Customer/单号/销售员) — 与 f_* 分面 chip 不同,
    // 多个列筛选框之间要求"且"(全部同时满足),故各自独立键写入 where,不进 facetOr。
    const colCode     = searchParams.get('colCode')?.trim()
    const colCustomer = searchParams.get('colCustomer')?.trim()
    const colSalesman = searchParams.get('colSalesman')?.trim()
    if (colCode)     where.code = { contains: colCode, mode: 'insensitive' }
    if (colCustomer) where.restaurantName = { contains: colCustomer, mode: 'insensitive' }
    if (colSalesman) where.salesUser = { name: { contains: colSalesman, mode: 'insensitive' } }

    // 分面聚焦搜索(facet)：多个维度的 chip 彼此 OR(命中任一即可,如 司机:bao 或 单号:260)，
    // 整体作为一块再与全局 search / 时间 / My 叠加(AND)。
    // 用 where.AND 数组组合，避免与全局 search 的 where.OR、categoryId 的 where.lines 键冲突。
    const facetAnd: Record<string, unknown>[] = []
    const facetOr: Record<string, unknown>[] = []
    const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })
    const fCode     = searchParams.get('f_code')?.trim()
    const fCustomer = searchParams.get('f_customer')?.trim()
    const fSalesman = searchParams.get('f_salesman')?.trim()
    const fProduct  = searchParams.get('f_product')?.trim()
    const fCategory = searchParams.get('f_category')?.trim()
    const fDriver   = searchParams.get('f_driver')?.trim()
    if (fCode)     facetOr.push({ code: like(fCode) })
    if (fCustomer) facetOr.push({ restaurantName: like(fCustomer) })
    if (fSalesman) facetOr.push({ salesUser: { name: like(fSalesman) } })
    if (fProduct)  facetOr.push({ lines: { some: { productName: like(fProduct) } } })
    if (fCategory) facetOr.push({ lines: { some: { product: { category: { OR: [
      { name: like(fCategory) },
      { nameZh: like(fCategory) },
    ] } } } } })
    if (fDriver)   facetOr.push({ driverSlot: { driverName: like(fDriver) } })
    if (facetOr.length > 0) facetAnd.push(facetOr.length === 1 ? facetOr[0] : { OR: facetOr })

    // 时间快捷筛选(Today/This Week…)按交货日期 deliveryDate(与销售单第二列/列筛口径一致)。
    // 走独立的 deliveryFrom/deliveryTo 放进 AND 数组，与交货日期列筛(where.deliveryDate)取交集、互不覆盖。
    const deliveryFrom = searchParams.get('deliveryFrom')
    const deliveryTo = searchParams.get('deliveryTo')
    if (deliveryFrom || deliveryTo) {
      const range: Record<string, Date> = {}
      if (deliveryFrom) range.gte = new Date(deliveryFrom + 'T00:00:00Z')
      if (deliveryTo) range.lte = new Date(deliveryTo + 'T23:59:59Z')
      facetAnd.push({ deliveryDate: range })
    }
    if (facetAnd.length > 0) where.AND = facetAnd

    // 表头点击排序 — 服务端全量排序后再分页,避免"排序只对当前页生效"(客户反馈)。
    // deliveryBatch/司机列是由 wave 派生的展示字段(见 attachWaveDisplay),数据库里没有直接可排序的列,
    // 该列排序仍由前端对当页数据做(见 orders/page.tsx),此处不支持。
    const sortFieldParam = searchParams.get('sortField') ?? 'createdAt'
    const sortDir = searchParams.get('sortDir') === 'asc' ? 'asc' as const : 'desc' as const
    const orderBy: Record<string, unknown> =
      sortFieldParam === 'code' ? { code: sortDir } :
      sortFieldParam === 'deliveryDate' ? { deliveryDate: sortDir } :
      sortFieldParam === 'quotationDate' ? { quotationDate: sortDir } :
      sortFieldParam === 'restaurantName' ? { restaurantName: sortDir } :
      sortFieldParam === 'totalAmount' ? { totalAmount: sortDir } :
      sortFieldParam === 'status' ? { status: sortDir } :
      sortFieldParam === 'salesman' ? { salesUser: { name: sortDir } } :
      { createdAt: sortDir }

    // SSOT: items 一律由 lines 实时投影。include_lines=false 时仍拉精简行(只取投影所需字段),
    // 既保留列表页轻量,又确保 items 永远新鲜(不读已腐化的 Order.items 列)。见 lib/order-items.ts。
    const leanLineSelect = {
      id: true, productId: true, productName: true, spec: true, note: true,
      uomId: true, uomName: true, unitPrice: true, taxRate: true,
      orderedQty: true, deliveredQty: true, invoicedQty: true, subtotal: true, sequence: true,
      commissionPrice: true,
    } as const
    const include = includeLines ? {
      lines: {
        orderBy: { sequence: 'asc' as const },
        include: {
          product: {
            select: {
              template: { select: { weight: true } },
            },
          },
        },
      },
      driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      salesUser: { select: { id: true, name: true } },
    } : {
      lines: { orderBy: { sequence: 'asc' as const }, select: leanLineSelect },
      salesUser: { select: { id: true, name: true } },
    }

    if (paginated) {
      const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include,
        }),
      ])
      const payload = serializeApi({
        data: orders,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      })
      payload.data = attachSalesmanDisplay(await attachWaveDisplay(deriveOrderItemsList(payload.data)))
      return NextResponse.json(payload)
    }

    // Legacy: flat array. When date range is provided, allow up to 5000 rows (for print reports).
    const hasDateFilter = !!(fromDate || toDate)
    const maxLimit = hasDateFilter ? 5000 : 500
    const limit = Math.min(maxLimit, Math.max(1, parseInt(searchParams.get('limit') ?? '500', 10)))
    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include,
    })
    return NextResponse.json(attachSalesmanDisplay(await attachWaveDisplay(deriveOrderItemsList(serializeApi(orders)))))
  } catch (error) {
    console.error('[GET /api/orders]', error)
    return NextResponse.json({ error: '获取订单失败' }, { status: 500 })
  }
}

/**
 * POST /api/orders
 *
 * ── 商业级修复 ─────────────────────────────────────────────────────────────
 * 1. 价格权威服务端重算：前端传来的 price 仅做参考；超过 €0.01 容差一律按权威价落库
 *    - priceType=multi  → 走 pricelist 引擎（支持嵌套、客户专属特殊价）
 *    - priceType=default → 直接用 product.listPrice
 *    - priceType=last   → 查该客户最近一次成交价，查无则回退牌价
 * 2. 事务化：订单创建 + 库存扣减 + stock_move 写入 作为一个原子事务（prisma.$transaction）
 *    - 任一步失败整体回滚，杜绝脏数据
 * 3. 库存扣减：qtyOnHand -= quantity（PRODUCT 类型商品），同时写 StockMove 流水
 *    - type=CONSU/SERVICE 不扣库存
 *    - qtyOnHand < quantity 则拒单，错误码 409 INSUFFICIENT_STOCK
 * 4. 幂等支持：Idempotency-Key header 重复请求返回上次结果
 */

// 幂等键缓存（进程内存；生产应接 Redis）
const idempotencyCache = new Map<string, { at: number; response: unknown }>()
const IDEM_TTL_MS = 10 * 60 * 1000 // 10 分钟

function cleanupIdem() {
  const now = Date.now()
  for (const [k, v] of idempotencyCache) {
    if (now - v.at > IDEM_TTL_MS) idempotencyCache.delete(k)
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    const idemKey = req.headers.get('Idempotency-Key')
    if (idemKey) {
      cleanupIdem()
      const cached = idempotencyCache.get(idemKey)
      if (cached) return NextResponse.json(serializeApi(cached.response), { status: 201 })
    }

    try {
      const data = await req.json()
      const restaurantId = data.restaurantId?.toString().trim()
      const restaurantName = data.restaurantName?.toString().trim().slice(0, 200) || '未知餐馆'
      if (!restaurantId) {
        return NextResponse.json({ error: '餐馆 ID 不能为空' }, { status: 400 })
      }

      const submittedItems = Array.isArray(data.items) ? data.items : []
      if (submittedItems.length === 0) {
        return NextResponse.json({ error: '订单商品不能为空' }, { status: 400 })
      }

      // P1-4: 自动获取客户默认司机 + 快照佣金率(下单时点)
      const custDefaults = await prisma.customer.findUnique({
        where: { id: restaurantId },
        select: { defaultDriverSlotId: true, commissionRate: true, commissionFixed: true, salesUserId: true, paymentTerm: true, creditLimit: true },
      })

      // 服务端信用管控校验
      if (custDefaults && custDefaults.paymentTerm !== 'cash') {
        const creditInvoices = await prisma.invoice.findMany({
          where: { customerId: restaurantId, status: 'POSTED' },
          select: { amountDue: true, dueDate: true },
        })
        const outstandingBalance = creditInvoices.reduce((s, inv) => s + Number(inv.amountDue), 0)
        const today = new Date().toISOString().slice(0, 10)
        const overdueAmount = creditInvoices
          .filter(inv => inv.dueDate && inv.dueDate < today)
          .reduce((s, inv) => s + Number(inv.amountDue), 0)
        const creditLimit = Number(custDefaults.creditLimit ?? 0)
        let blocked = false
        if (creditLimit > 0 && outstandingBalance >= creditLimit) blocked = true
        if (overdueAmount > 0 && custDefaults.paymentTerm === 'monthly') blocked = true
        if (blocked && !['BOSS', 'FINANCE'].includes(user.role)) {
          return NextResponse.json({ error: '客户信用冻结，请联系财务或主管特批' }, { status: 403 })
        }
      }
      let resolvedDriverSlotId = data.driverSlotId || null
      if (!resolvedDriverSlotId && custDefaults?.defaultDriverSlotId) {
        resolvedDriverSlotId = custDefaults.defaultDriverSlotId
      }

      // 1) 服务端权威定价（同步查 customer / products / pricelists / last-price）
      const {
        lines,
        totalAmount,
        pricelistId,
        priceType,
        warnings,
      } = await resolveOrderLines({ prisma, restaurantId }, submittedItems, {
        pricelistId: data.pricelistId ?? undefined,
        priceType: data.priceType ?? undefined,
      })

      // 2) 预加载商品数据（用于后续事务；报价单阶段不做库存检查）
      //    库存充足性检查推迟到「确认订单」时执行（Odoo 行为：PENDING 阶段不占用库存）
      const productIds = lines.map((l) => l.productId)
      const productsForStock = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { template: { select: { type: true, commissionPrice: true } } },
      })
      const stockMap = new Map(productsForStock.map((p) => [p.id, p]))
      // 件提成单价：优先取 Product.commissionPrice，fallback 到 ProductTemplate.commissionPrice
      const commissionPriceMap = new Map(
        productsForStock.map((p) => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
      )

      // 3) 事务：仅创建订单，不扣库存（报价单阶段）
      // 业务编号：创建者缩写-YYMMDD-NNN（CJ-260424-001）。
      // 唯一索引 + P2002 重试，应对并发场景下两个事务计算到同一序号的极端情况。
      const initials = getInitials(user.name, user.email)
      const now = new Date()
      const MAX_RETRY = 5
      let order: Awaited<ReturnType<typeof prisma.order.create>> | null = null
      let lastErr: unknown = null
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
          order = await prisma.$transaction(async (tx) => {
            const code = await nextOrderCode(tx, initials, now)
            const orderCreated = await tx.order.create({
              data: {
                code,
                createdById: user.userId,
                createdByName: user.name,
                restaurantId,
                restaurantName,
                items: toOrderItems(lines) as unknown as object,
                totalAmount,
                status: normalizeStatus(data.status),
                paymentMethod: normalizePaymentMethod(data.paymentMethod),
                pricelistId,
                priceType,
                // SSOT: 下单时快照客户佣金率(此前 schema 注释承诺但从不写,恒 null)(P2)
                commissionRate: custDefaults?.commissionRate ?? null,
                // SSOT: 下单时快照客户固定辛苦费(此前 select 未取该字段,恒 null)
                commissionFixed: custDefaults?.commissionFixed ?? null,
                quotationDate: normalizeDateOnly(data.quotationDate) ?? new Date(),
                deliveryDate: normalizeDateOnly(data.deliveryDate),
                driverSlotId: resolvedDriverSlotId,
                internalNote: data.internalNote ? String(data.internalNote).slice(0, 30) : undefined,
                externalNote: data.externalNote ? String(data.externalNote) : undefined,
                // SSOT: 业务员关联用户。优先手选值,未选则回退客户默认业务员(Customer.salesUserId)。
                salesUserId: (data.salesUserId ? String(data.salesUserId) : custDefaults?.salesUserId) || undefined,
                lines: {
                  create: lines.map((l, idx) => ({
                    productId: l.productId,
                    productName: l.productName,
                    spec: l.spec ?? null,
                    note: l.note ?? null,
                    uomId: l.uomId ?? null,
                    uomName: l.uomName ?? null,
                    unitPrice: l.authoritativeUnitPrice,
                    taxRate: l.taxRate ?? null,
                    orderedQty: l.quantity,
                    deliveredQty: 0,
                    invoicedQty: 0,
                    subtotal: Number((l.authoritativeUnitPrice * l.quantity).toFixed(2)),
                    commissionPrice: commissionPriceMap.get(l.productId) ?? null,
                    sequence: idx,
                  })),
                },
              },
            })

            // 报价单阶段不扣库存、不写 StockMove
            // 库存预留在「确认订单」（PENDING→CONFIRMED）时处理

            return orderCreated
          })
          break // 成功
        } catch (e: unknown) {
          lastErr = e
          // P2002: 唯一约束冲突 —— 多半是 code 序号撞车，重算重试
          const code = (e as { code?: string }).code
          const meta = (e as { meta?: { target?: string[] } }).meta
          if (code === 'P2002' && meta?.target?.includes('code')) {
            continue
          }
          throw e
        }
      }
      if (!order) {
        throw lastErr ?? new Error('生成订单编号失败')
      }

      // 写订单审计日志（action='created'）—— 时间线起点
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prismaAny = prisma as any
      await prismaAny.orderAuditLog.create({
        data: {
          orderId: order.id,
          userId: user.userId,
          action: 'created',
          totalBefore: null,
          totalAfter: toNum(order.totalAmount),
          changedFields: {
            status: { before: null, after: String(order.status) },
            itemCount: lines.length,
            lineChanges: {
              added: lines.map(l => ({
                productName: l.productName,
                qty: l.quantity,
                unitPrice: l.authoritativeUnitPrice,
              })),
              deleted: [],
              modified: [],
            },
          },
        },
      }).catch((e: unknown) => console.error('[OrderAuditLog created]', e))

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'CREATE',
        resource: 'order',
        resourceId: order.id,
        detail: `创建订单: ${order.id}, 金额 €${totalAmount}, pricelist=${pricelistId ?? 'N/A'}, priceType=${priceType ?? 'multi'}${warnings.length ? ', 警告: ' + warnings.join('; ') : ''}`,
      })

      // 邮件确认（不阻塞）
      if (process.env.RESEND_API_KEY) {
        const cust = await prisma.customer.findFirst({
          where: { id: restaurantId },
          select: { email: true, name: true },
        })
        if (cust?.email) {
          sendOrderConfirmation({
            to: cust.email,
            customerName: cust.name,
            orderId: order.id,
            items: lines.map((l) => ({
              name: l.productName,
              qty: l.quantity,
              unit: l.spec || '件',
              price: l.authoritativeUnitPrice,
            })),
            total: totalAmount,
          }).catch((e) => console.error('[email] order confirmation failed:', e))
        }
      }

      // 这里 `as any` 只是为了在未重新 generate 前的 Prisma 客户端下能编译；
      // 执行 `npx prisma generate` 后 commissionRate 字段会自动进入类型。
      const orderAny = order as unknown as Record<string, unknown>
      const response = {
        ...order,
        totalAmount: toNum(order.totalAmount),
        commissionRate: orderAny.commissionRate !== null && orderAny.commissionRate !== undefined
          ? toNum(orderAny.commissionRate)
          : null,
        pricingWarnings: warnings,
        pricingDetail: lines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          authoritativePrice: l.authoritativeUnitPrice,
          submittedPrice: l.submittedUnitPrice,
          priceMatched: l.accepted,
          ruleSource: l.resolution.itemDesc,
          pricelistName: l.resolution.pricelistName,
          isSpecialPrice: l.resolution.isSpecialPrice ?? false,
        })),
      }

      const serialized = serializeApi(response)
      if (idemKey) idempotencyCache.set(idemKey, { at: Date.now(), response: serialized })

      return NextResponse.json(serialized, { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/orders]', error)
      return NextResponse.json({ error: '创建订单失败' }, { status: 500 })
    }
  })
}
