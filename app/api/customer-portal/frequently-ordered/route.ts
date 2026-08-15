import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { loadCustomerFromRestaurantId } from '@/lib/server-pricing'
import { toNum } from '@/lib/decimal-helpers'

const TOP_N = 8

/**
 * GET /api/customer-portal/frequently-ordered — 常购清单
 * 按该客户历史订单里每个商品出现的次数排序，取最常购买的前 N 个，
 * 附带最近一次的下单数量，供前端"一键快捷复购"预填数量。
 */
export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const customer = await loadCustomerFromRestaurantId(prisma, user.userId)
      if (!customer) {
        return NextResponse.json({ error: '未找到关联客户信息，请联系管理员' }, { status: 403 })
      }

      // 与 lib/server-pricing.ts 的 queryLastSoldPricesDetailed 同一套 restaurantId 解析逻辑：
      // 应用内下单走 User.id，Odoo 历史导入 / 操作员直接给 Customer 下单则 restaurantId 就是 Customer.id。
      const linkedUsers = await prisma.user.findMany({
        where: { customerId: customer.id },
        select: { id: true },
      })
      const restaurantIds = [customer.id, ...linkedUsers.map((u) => u.id)]

      // ⚠️ 这里**刻意保留 PENDING**，与 `lib/order-status.ts` 的 SALE_ORDER_STATUSES 不同 ——
      // 不是漏改。两者问的不是同一个问题：
      //   · 历史成交价问「这货实际卖过多少钱」→ 报价单只是要价，不算数（X9 修的就是那个）
      //   · 常购清单问「我常买什么」→ 客户在门户提交的单**落地就是 PENDING**，
      //     排掉的话，他刚下的单不会进自己的常购清单，得等运营确认才出现，那才是错的
      const lines = await prisma.orderLine.findMany({
        where: { order: { restaurantId: { in: restaurantIds }, status: { not: 'CANCELLED' } } },
        select: { productId: true, orderedQty: true, order: { select: { createdAt: true } } },
        orderBy: { order: { createdAt: 'desc' } },
      })

      const byProduct = new Map<string, { orderCount: number; lastQuantity: number; lastOrderedAt: Date }>()
      for (const line of lines) {
        const existing = byProduct.get(line.productId)
        if (existing) {
          existing.orderCount += 1
        } else {
          // lines 已按订单时间倒序，首次遇到即为该商品最近一次的下单记录
          byProduct.set(line.productId, {
            orderCount: 1,
            lastQuantity: toNum(line.orderedQty),
            lastOrderedAt: line.order.createdAt,
          })
        }
      }

      const result = [...byProduct.entries()]
        .map(([productId, stats]) => ({ productId, ...stats }))
        .sort((a, b) => b.orderCount - a.orderCount || b.lastOrderedAt.getTime() - a.lastOrderedAt.getTime())
        .slice(0, TOP_N)

      return NextResponse.json(serializeApi(result))
    } catch (error) {
      console.error('[GET /api/customer-portal/frequently-ordered]', error)
      return NextResponse.json({ error: '获取常购清单失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
