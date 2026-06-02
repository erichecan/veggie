import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth, tryAuth, effectiveRoles } from '@/lib/auth'
import { sendOrderConfirmation } from '@/lib/email'
import { resolveOrderLines, toOrderItems } from '@/lib/server-pricing'
import { toNum } from '@/lib/decimal-helpers'
import { serializeApi } from '@/lib/api-serializer'
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

    // ?deliveryBatch=1 am BAO — filter by delivery batch
    const deliveryBatch = searchParams.get('deliveryBatch')
    if (deliveryBatch) where.deliveryBatch = deliveryBatch

    const driverSlotId = searchParams.get('driverSlotId')
    if (driverSlotId) where.driverSlotId = driverSlotId

    // ?salesman=John — filter by salesman name
    const salesman = searchParams.get('salesman')
    if (salesman) where.salesman = salesman

    // P1-3: SALES 角色自动过滤 — 只看自己名下的订单
    if (!salesman) {
      const caller = await tryAuth(req)
      if (caller) {
        const roles = effectiveRoles(caller)
        if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
          where.salesman = caller.name
        }
      }
    }

    // ?categoryId=xxx — filter orders that have at least one line with product in this category
    const categoryId = searchParams.get('categoryId')
    if (categoryId) {
      where.lines = { some: { product: { categoryId } } }
    }

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
    } : undefined

    if (paginated) {
      const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include,
        }),
      ])
      return NextResponse.json(serializeApi({
        data: orders,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }))
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
    return NextResponse.json(serializeApi(orders))
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

      // P1-4: 自动获取客户默认司机（如果前端未指定 driverSlotId）
      let resolvedDriverSlotId = data.driverSlotId || null
      if (!resolvedDriverSlotId) {
        const cust = await prisma.customer.findUnique({
          where: { id: restaurantId },
          select: { defaultDriverSlotId: true },
        })
        if (cust?.defaultDriverSlotId) resolvedDriverSlotId = cust.defaultDriverSlotId
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
        include: { template: { select: { type: true } } },
      })
      const stockMap = new Map(productsForStock.map((p) => [p.id, p]))

      // 3) 事务：仅创建订单，不扣库存（报价单阶段）
      // 业务编号：创建者缩写-YYMMDD-NNN（CJ-260424-001）。
      // 唯一索引 + P2002 重试，应对并发场景下两个事务计算到同一序号的极端情况。
      const initials = getInitials(user.name)
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
                quotationDate: normalizeDateOnly(data.quotationDate) ?? new Date(),
                deliveryDate: normalizeDateOnly(data.deliveryDate),
                driverSlotId: resolvedDriverSlotId,
                internalNote: data.internalNote ? String(data.internalNote).slice(0, 30) : undefined,
                salesman: data.salesman ? String(data.salesman).slice(0, 100) : undefined,
                lines: {
                  create: lines.map((l, idx) => ({
                    productId: l.productId,
                    productName: l.productName,
                    spec: l.spec ?? null,
                    uomId: l.uomId ?? null,
                    uomName: l.uomName ?? null,
                    unitPrice: l.authoritativeUnitPrice,
                    taxRate: l.taxRate ?? null,
                    orderedQty: l.quantity,
                    deliveredQty: 0,
                    invoicedQty: 0,
                    subtotal: Number((l.authoritativeUnitPrice * l.quantity).toFixed(2)),
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
