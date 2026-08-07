import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { notifyRole } from '@/lib/notify'
import { serializeApi } from '@/lib/api-serializer'
import { deriveOrderItemsList } from '@/lib/order-items'
import { resolveOrderLines, toOrderItems } from '@/lib/server-pricing'
import { toNum } from '@/lib/decimal-helpers'
import { getInitials, nextOrderCode } from '@/lib/order-code'
import type { $Enums } from '@/lib/generated/prisma/client'

/**
 * P1-2: 客户小程序 — 订单管理
 *
 * GET  /api/customer-portal/orders   — 客户查看自己的订单列表
 * POST /api/customer-portal/orders   — 客户自助下单
 *
 * 角色：RESTAURANT（客户登录后自动获得）
 * 安全：restaurantId 始终从 JWT 的 userId 获取，客户只能看/操作自己的订单
 */

const ORDER_STATUSES = new Set<$Enums.OrderStatus>([
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED',
])
const PAYMENT_METHODS = new Set<$Enums.PaymentMethod>(['ONLINE', 'CASH'])

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

// ── 幂等支持 ────────────────────────────────────────────────────────────────
const idempotencyCache = new Map<string, { at: number; response: unknown }>()
const IDEM_TTL_MS = 10 * 60 * 1000

function cleanupIdem() {
  const now = Date.now()
  for (const [k, v] of idempotencyCache) {
    if (now - v.at > IDEM_TTL_MS) idempotencyCache.delete(k)
  }
}

/**
 * GET — 客户查看自己的订单
 *
 * Query params:
 *   ?status=PENDING,CONFIRMED  — 按状态筛选（逗号分隔）
 *   ?search=CJ-260424          — 按订单编号模糊搜索
 *   ?page=1&pageSize=20        — 分页
 */
export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { searchParams } = new URL(req.url)

      // 客户只能看自己的订单（restaurantId = JWT userId）
      const restaurantId = user.userId

      const statusParam = searchParams.get('status')
      const statusFilter = statusParam
        ? statusParam.split(',').map(s => s.trim().toUpperCase())
            .filter(s => ORDER_STATUSES.has(s as $Enums.OrderStatus)) as $Enums.OrderStatus[]
        : null

      const search = searchParams.get('search')?.trim() ?? ''

      const rawPageSize = parseInt(searchParams.get('pageSize') ?? '20', 10)
      const pageSize = Math.min(100, Math.max(1, rawPageSize))
      const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

      const where: Record<string, unknown> = { restaurantId }
      if (statusFilter && statusFilter.length > 0) where.status = { in: statusFilter }
      if (search) {
        where.code = { contains: search, mode: 'insensitive' }
      }

      const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            code: true,
            status: true,
            totalAmount: true,
            paymentMethod: true,
            deliveryDate: true,
            createdAt: true,
            items: true,
            lines: {
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                productId: true,
                productName: true,
                spec: true,
                uomName: true,
                unitPrice: true,
                orderedQty: true,
                deliveredQty: true,
                subtotal: true,
              },
            },
          },
        }),
      ])

      const payload = serializeApi({
        data: orders,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      })
      payload.data = deriveOrderItemsList(payload.data)
      return NextResponse.json(payload)
    } catch (error) {
      console.error('[GET /api/customer-portal/orders]', error)
      return NextResponse.json({ error: '获取订单列表失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}

/**
 * POST — 客户自助下单
 *
 * 请求体:
 *   {
 *     items: [{ productId, quantity, price? }],
 *     deliveryDate?: "2026-05-23",
 *     paymentMethod?: "CASH" | "ONLINE",
 *     internalNote?: string
 *   }
 *
 * - restaurantId 从 JWT 获取（客户只能给自己下单）
 * - 价格权威重算，前端 price 仅参考
 * - 支持幂等（Idempotency-Key header）
 * - 自动解析 P1-4 默认司机绑定
 */
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

      // 客户只能给自己下单
      const restaurantId = user.userId

      // 拉客户信息（名称 + 默认司机）
      const customer = await prisma.customer.findUnique({
        where: { id: restaurantId },
        select: { name: true, defaultDriverSlotId: true },
      })
      const restaurantName = customer?.name ?? user.name ?? '客户'
      const resolvedDriverSlotId = customer?.defaultDriverSlotId ?? null

      const submittedItems = Array.isArray(data.items) ? data.items : []
      if (submittedItems.length === 0) {
        return NextResponse.json({ error: '订单商品不能为空' }, { status: 400 })
      }

      // 服务端权威定价
      const {
        lines,
        totalAmount,
        pricelistId,
        priceType,
        warnings,
      } = await resolveOrderLines({ prisma, restaurantId }, submittedItems)

      // 事务创建订单 + P2002 重试
      const initials = getInitials(restaurantName, user.email)
      const now = new Date()
      const MAX_RETRY = 5
      let order: Awaited<ReturnType<typeof prisma.order.create>> | null = null
      let lastErr: unknown = null

      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
          order = await prisma.$transaction(async (tx) => {
            const code = await nextOrderCode(tx, initials, now)
            return tx.order.create({
              data: {
                code,
                createdById: user.userId,
                createdByName: restaurantName,
                restaurantId,
                restaurantName,
                items: toOrderItems(lines) as unknown as object,
                totalAmount,
                status: 'PENDING',
                paymentMethod: normalizePaymentMethod(data.paymentMethod),
                pricelistId,
                priceType,
                quotationDate: normalizeDateOnly(data.quotationDate) ?? now,
                deliveryDate: normalizeDateOnly(data.deliveryDate),
                driverSlotId: resolvedDriverSlotId,
                internalNote: data.internalNote
                  ? String(data.internalNote).slice(0, 30)
                  : undefined,
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
          })
          break
        } catch (e: unknown) {
          lastErr = e
          const code = (e as { code?: string }).code
          const meta = (e as { meta?: { target?: string[] } }).meta
          if (code === 'P2002' && meta?.target?.includes('code')) continue
          throw e
        }
      }
      if (!order) throw lastErr ?? new Error('生成订单编号失败')

      // 审计日志
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
            status: { before: null, after: 'PENDING' },
            source: 'customer-portal',
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
      }).catch((e: unknown) => console.error('[OrderAuditLog customer-portal]', e))

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: restaurantName,
        action: 'CREATE',
        resource: 'order',
        resourceId: order.id,
        detail: `客户自助下单: ${order.code ?? order.id}, 金额 €${totalAmount}, ${lines.length}项商品`,
      })

      // 通知运营:有新的自助订单待确认(旁路,失败不影响下单)
      await notifyRole(['OPERATOR'], {
        type: 'order_update',
        title: `新订单待确认:${restaurantName}`,
        body: `${restaurantName} 自助下单 ${order.code ?? order.id},${lines.length} 项商品,金额 €${totalAmount.toFixed(2)},请到报价单页确认。`,
        data: { orderId: order.id, orderCode: order.code },
      })

      const response = {
        id: order.id,
        code: order.code,
        status: order.status,
        totalAmount: toNum(order.totalAmount),
        deliveryDate: order.deliveryDate,
        createdAt: order.createdAt,
        lineCount: lines.length,
        pricingWarnings: warnings,
      }

      const serialized = serializeApi(response)
      if (idemKey) idempotencyCache.set(idemKey, { at: Date.now(), response: serialized })

      return NextResponse.json(serialized, { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/customer-portal/orders]', error)
      return NextResponse.json({ error: '下单失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
