import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { sendOrderConfirmation } from '@/lib/email'
import { resolveOrderLines, toOrderItems } from '@/lib/server-pricing'
import { toNum } from '@/lib/decimal-helpers'
import { serializeApi } from '@/lib/api-serializer'
import { deriveOrderItemsList } from '@/lib/order-items'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { ORDER_STATUSES, buildOrdersWhere } from '@/lib/orders-query'

// 只读展示兼容层：salesUser 关联展平成 salesman 字符串,方便旧的只读页面(报表/打印/列表)
// 不用改动就能继续显示业务员姓名。写入路径一律走 salesUserId,不读这个字段。
function attachSalesmanDisplay<T extends { salesUser?: { id: string; name: string } | null }>(orders: T[]): (T & { salesman: string | null })[] {
  return orders.map((o) => ({ ...o, salesman: o.salesUser?.name ?? null }))
}
import type { $Enums } from '@/lib/generated/prisma/client'
import { getInitials, nextOrderCode } from '@/lib/order-code'

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
    const includeLines = searchParams.get('include_lines') !== 'false'

    // ?fromDate/?toDate/?deliveryFrom/?deliveryTo 在下方分页判断里还要单独用到,
    // where 本身的构建已经下沉到 buildOrdersWhere(与 export-csv 共用同一套筛选口径)。
    const fromDate = searchParams.get('fromDate')
    const toDate = searchParams.get('toDate')
    const deliveryFrom = searchParams.get('deliveryFrom')
    const deliveryTo = searchParams.get('deliveryTo')

    // ?page= & ?pageSize= → server-side pagination (pageSize=0 or absent → legacy flat array)
    const rawPageSize = parseInt(searchParams.get('pageSize') ?? '0', 10)
    const paginated = rawPageSize > 0
    const pageSize = paginated ? Math.min(200, Math.max(1, rawPageSize)) : 0
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

    const where = await buildOrdersWhere(req, searchParams)

    // 表头点击排序 — 服务端全量排序后再分页,避免"排序只对当前页生效"(客户反馈)。
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
      // deliveryBatch/司机列是 wave 派生展示字段(见 attachWaveDisplay),SQL 层没有直接可 ORDER BY
      // 的列,没法走下面 skip/take 那条路——之前直接放弃下推,排序退化成"只排当前页"(客户反馈:
      // 昨晚其它列排序已下推服务端,司机列却还是老样子)。这里改成取全量匹配集在内存里按派生
      // 显示值排序后再手动切页;数据量按跟 legacy 分支一致的口径封顶,避免无界查询拖垮内存。
      if (sortFieldParam === 'deliveryBatch') {
        const hasDateFilterForSort = !!(fromDate || toDate || deliveryFrom || deliveryTo)
        const sortLimit = hasDateFilterForSort ? 5000 : 500
        const allMatching = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: sortLimit, include })
        const withWave = attachSalesmanDisplay(await attachWaveDisplay(deriveOrderItemsList(serializeApi(allMatching))))
        withWave.sort((a, b) => {
          const av = formatDriverSlotFromOrder(a)
          const bv = formatDriverSlotFromOrder(b)
          return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
        })
        const total = withWave.length
        const start = (page - 1) * pageSize
        return NextResponse.json({
          data: withWave.slice(start, start + pageSize),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        })
      }

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
                internalNote: data.internalNote ? String(data.internalNote) : undefined,
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
                    // 单价来源快照：服务端权威定价(resolveOrderLines)算出的 sourceType，
                    // 供订单详情页"Price"列 hover 展示来源，历史订单没有这三个字段
                    priceSourceType: l.resolution.sourceType.toUpperCase(),
                    priceSourceDetail: l.resolution.sourceType === 'pricelist' ? l.resolution.pricelistName : null,
                    priceSourceDate: l.lastPriceDate ?? null,
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
