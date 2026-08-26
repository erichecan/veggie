import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'
import { displayOrderCode } from '@/lib/order-code'
import { SALE_ORDER_STATUSES } from '@/lib/order-status'

/**
 * GET /api/orders/sales-price-history?customerId=X&productId=Y&limit=20
 *
 * 某商品卖给某客户的历史成交价（最近 N 条），供订单/报价单行的
 * "历史价格" 弹窗使用，可选中某条替换本次单价。
 *
 * 必须查 OrderLine（关系表），不能查 Order.items JSON：
 * 15 万笔 Odoo 历史导入订单的 items 恒为空数组，且订单一旦被编辑过
 * items 也不再跟随 OrderLine 更新（见 docs/20260624-data-ownership-audit.md）。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const customerId = searchParams.get('customerId')
      const productId = searchParams.get('productId')
      const limit = Math.min(Number(searchParams.get('limit')) || 20, 50)

      if (!customerId || !productId) {
        return NextResponse.json({ error: 'customerId 和 productId 为必填参数' }, { status: 400 })
      }

      // Order.restaurantId 有两种历史写法（见 docs/20260624-data-ownership-audit.md）：
      // 应用内下单走 User.id（该 User.customerId 关联 Customer）；
      // Odoo 历史导入订单直接把 Customer.id 存进 restaurantId（未建对应 User 账号）。
      // 两种都要匹配，否则十几万笔导入订单的历史价格会查不到。
      const users = await prisma.user.findMany({
        where: { customerId },
        select: { id: true },
      })
      const restaurantIds = [customerId, ...users.map(u => u.id)]

      const lines = await prisma.orderLine.findMany({
        where: {
          productId,
          order: {
            restaurantId: { in: restaurantIds },
            // 与 lib/server-pricing 的 queryLastSoldPricesDetailed 同口径：只算真正成交过的单。
            // 弹窗列的是「历史成交价」，混进报价单的话，行上 Last 徽标那个数与本弹窗
            // 第一行会对不上 —— 同一件事在两处各算一遍，正是最难查的那类不一致
            status: { in: SALE_ORDER_STATUSES },
          },
        },
        orderBy: { order: { createdAt: 'desc' } },
        take: limit,
        select: {
          orderedQty: true,
          unitPrice: true,
          uomName: true,
          order: { select: { id: true, code: true, createdAt: true } },
        },
      })

      const history = lines.map(l => ({
        date: l.order.createdAt,
        orderId: l.order.id,
        orderNumber: displayOrderCode(l.order),
        quantity: toNum(l.orderedQty),
        unitPrice: toNum(l.unitPrice),
        // 同一商品配了多个可售单位时，单价差得很大——不带单位这个历史价没法看懂
        // 对不对得上，客户 20260826 报过。
        uom: l.uomName || null,
      }))

      return NextResponse.json({ history })
    } catch (error) {
      console.error('[GET /api/orders/sales-price-history]', error)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }
  })
}
