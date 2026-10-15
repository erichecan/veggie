import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'
import { ORDER_RESERVED_STATUSES, ORDER_STOCK_SOURCE_TYPES } from '@/lib/order-stock'

/**
 * GET /api/products/forecast?ids=p1,p2,p3 —— 在手 / 预测库存（20261015 改为与采购对称，即 Odoo 口径）
 * ============================================================================
 *   qtyOnHand        在手 = 仓库实物 = Product.qtyOnHand = Σ 库存流水。
 *                    采购收货时增加；销售在货离仓（确认出发 / 完成）时减少，确认订单时**不变**。
 *   inboundPending   采购在途 = 已确认 PO 未收数量（换算成基础单位）
 *   outboundReserved 待出库 = 已确认、还没出库的销售需求（换算成基础单位，见 untakenOrderDemand 的口径）
 *   forecast         预测 = 在手 + 采购在途 − 待出库
 *   availableQty     可用 = 在手 − 待出库
 *
 * 对照：采购确认 → forecast +、在手不变；收货 → 在手 +。销售确认 → forecast −、在手不变；出库 → 在手 −。
 * ⛔ 20261014 之前：forecast 只对 WAVE_ASSIGNED/IN_DELIVERY 减未送量、COMPLETED 后不减，
 *    Place Order 直接确认又不扣在手，于是走完流程两个数都回到原值（客户 Pepper Green 截图）。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const idsParam = searchParams.get('ids') ?? ''
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
      if (ids.length === 0) return NextResponse.json([])
      if (ids.length > 200) {
        return NextResponse.json({ error: '一次最多查询 200 个商品' }, { status: 400 })
      }

      const products = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, qtyOnHand: true, safetyStockMin: true },
      })

      // 未送达订单：目标占用（orderedQty 换算成基础单位）vs 流水里实际拿走的
      const activeLines = await prisma.orderLine.findMany({
        where: { productId: { in: ids }, order: { status: { in: [...ORDER_RESERVED_STATUSES] as never[] } } },
        select: { orderId: true, productId: true, orderedQty: true, uomId: true },
      })
      const target = new Map<string, number>() // `${orderId}|${productId}` → 基础单位数量
      for (const l of activeLines) {
        const q = toNum(l.orderedQty)
        if (!(q > 0)) continue
        const k = `${l.orderId}|${l.productId}`
        target.set(k, (target.get(k) ?? 0) + await toStockQty(prisma as never, l.productId, q, l.uomId))
      }
      const orderIds = [...new Set(activeLines.map(l => l.orderId))]
      const takenRows = orderIds.length
        ? await prisma.stockMove.groupBy({
            by: ['sourceId', 'productId'],
            where: { sourceType: { in: ORDER_STOCK_SOURCE_TYPES }, sourceId: { in: orderIds }, productId: { in: ids } },
            _sum: { qty: true },
          })
        : []
      const taken = new Map(takenRows.map(r => [`${r.sourceId}|${r.productId}`, -toNum(r._sum.qty)]))
      const notTakenMap = new Map<string, number>()
      for (const [k, t] of target) {
        const productId = k.split('|')[1]
        const got = Math.max(0, taken.get(k) ?? 0)
        if (t - got > 0.0005) notTakenMap.set(productId, (notTakenMap.get(productId) ?? 0) + (t - got))
      }

      // 在途采购：已确认 PO 的未收数量（RECEIVED 状态各行已收齐，pending<=0 自然被滤掉）
      const poLines = await prisma.purchaseOrderLine.findMany({
        where: { productId: { in: ids }, purchaseOrder: { status: { in: ['CONFIRMED', 'RECEIVED'] } } },
        select: { productId: true, orderedQty: true, receivedQty: true, uomId: true },
      })
      const inboundMap = new Map<string, number>()
      for (const l of poLines) {
        const pending = toNum(l.orderedQty) - toNum(l.receivedQty)
        if (!(pending > 0) || !l.productId) continue
        const stockQty = await toStockQty(prisma as never, l.productId, pending, l.uomId ?? null)
        inboundMap.set(l.productId, (inboundMap.get(l.productId) ?? 0) + stockQty)
      }

      const r3 = (v: number) => Math.round(v * 1000) / 1000
      const result = products.map(p => {
        const onHand = toNum(p.qtyOnHand)
        const safetyMin = toNum(p.safetyStockMin)
        const inbound = r3(inboundMap.get(p.id) ?? 0)
        const outbound = r3(notTakenMap.get(p.id) ?? 0)
        const forecast = r3(onHand + inbound - outbound)
        return {
          productId: p.id,
          qtyOnHand: onHand,
          physicalQty: onHand,
          safetyStockMin: safetyMin,
          lockedQty: outbound,
          availableQty: r3(onHand - outbound),
          inboundPending: inbound,
          outboundReserved: outbound,
          forecast,
          belowSafetyStock: forecast < safetyMin && safetyMin > 0,
        }
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[GET /api/products/forecast]', error)
      return NextResponse.json({ error: '获取预测库存失败' }, { status: 500 })
    }
  })
}
