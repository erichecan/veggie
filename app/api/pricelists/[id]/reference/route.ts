import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'
import { displayOrderCode } from '@/lib/order-code'
import { SALE_ORDER_STATUSES } from '@/lib/order-status'

const HISTORY_LIMIT = 10

/**
 * GET /api/pricelists/[id]/reference?productId=X
 *
 * 定价参考数据，供价格表新建/编辑条目时使用：
 *   - lastPrices：**用这张价格表的客户们**最近对该商品的真实成交价（不是全平台，
 *     价格表本身不挂在单一客户上，只有通过 CustomerPricelist 反查才知道"谁在用它"，
 *     范围收在这些客户身上才对得上"这张表定的价跟不跟得上市场"这个意图）
 *   - lastPurchase：该商品最近一次入库的采购成本（Lot.unitCost，基准单位口径，
 *     与 Product.standardPrice 同源但不是移动平均——避免均价掩盖"最近这批其实涨价了"）
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: pricelistId } = await params
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const productId = searchParams.get('productId')
      if (!productId) {
        return NextResponse.json({ error: 'productId 为必填参数' }, { status: 400 })
      }

      const [customerLinks, lastPurchase] = await Promise.all([
        prisma.customerPricelist.findMany({
          where: { pricelistId },
          select: { customerId: true },
        }),
        prisma.lot.findFirst({
          where: { productId },
          orderBy: { arrivedAt: 'desc' },
          select: { unitCost: true, arrivedAt: true, sourceRef: true },
        }),
      ])

      // Lot 存在但 unitCost 为 null（历史批次回填不到）时不能拿 toNum 的兜底 0 冒充成本
      const lastPurchasePayload = lastPurchase && lastPurchase.unitCost != null
        ? { unitCost: toNum(lastPurchase.unitCost), date: lastPurchase.arrivedAt, sourceRef: lastPurchase.sourceRef }
        : null

      const customerIds = [...new Set(customerLinks.map(c => c.customerId))]
      if (customerIds.length === 0) {
        return NextResponse.json({
          lastPrices: [],
          avgLastPrice: null,
          customerCount: 0,
          lastPurchase: lastPurchasePayload,
        })
      }

      // Order.restaurantId 双写法同 sales-price-history：应用内下单走 User.id，
      // Odoo 历史导入订单直接把 Customer.id 存进 restaurantId。
      const [users, customers] = await Promise.all([
        prisma.user.findMany({ where: { customerId: { in: customerIds } }, select: { id: true, customerId: true } }),
        prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
      ])
      const customerNameOf = new Map(customers.map(c => [c.id, c.name]))
      // restaurantId → 客户名：直接是 customerId 的场景，与经由 User.customerId 间接关联的场景都要覆盖
      const nameByRestaurantId = new Map<string, string>()
      for (const c of customers) nameByRestaurantId.set(c.id, c.name)
      for (const u of users) {
        const name = u.customerId ? customerNameOf.get(u.customerId) : undefined
        if (name) nameByRestaurantId.set(u.id, name)
      }
      const restaurantIds = [...customerIds, ...users.map(u => u.id)]

      const lines = await prisma.orderLine.findMany({
        where: {
          productId,
          order: {
            restaurantId: { in: restaurantIds },
            status: { in: SALE_ORDER_STATUSES },
          },
        },
        orderBy: { order: { createdAt: 'desc' } },
        take: HISTORY_LIMIT,
        select: {
          orderedQty: true,
          unitPrice: true,
          uomName: true,
          order: { select: { id: true, code: true, createdAt: true, restaurantId: true } },
        },
      })

      const lastPrices = lines.map(l => ({
        date: l.order.createdAt,
        orderId: l.order.id,
        orderNumber: displayOrderCode(l.order),
        customerName: nameByRestaurantId.get(l.order.restaurantId) ?? null,
        quantity: toNum(l.orderedQty),
        unitPrice: toNum(l.unitPrice),
        uom: l.uomName || null,
      }))
      const avgLastPrice = lastPrices.length > 0
        ? Math.round((lastPrices.reduce((s, p) => s + p.unitPrice, 0) / lastPrices.length) * 100) / 100
        : null

      return NextResponse.json({
        lastPrices,
        avgLastPrice,
        customerCount: customerIds.length,
        lastPurchase: lastPurchasePayload,
      })
    } catch (error) {
      console.error('[GET /api/pricelists/[id]/reference]', error)
      return NextResponse.json({ error: '查询定价参考数据失败' }, { status: 500 })
    }
  })
}
