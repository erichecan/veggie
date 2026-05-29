import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/products/forecast?ids=p1,p2,p3
 * Returns: [{ productId, qtyOnHand, inboundPending, outboundReserved, forecast }]
 *
 * forecast = qtyOnHand
 *          + (PurchaseOrderLine.orderedQty - receivedQty)   // 在途采购
 *          - Σ OrderLine.orderedQty + Σ OrderLine.deliveredQty  // 在途销售（已确认未交货）
 *   where Order.status ∈ {CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY}
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

      // P1-1: 实时库存锁定 — CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY 三个状态都计入
      // CONFIRMED 时 qtyOnHand 已扣减，但需要展示"锁定量"让用户了解多少库存被订单占用
      const allActiveStatuses = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] as const
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prismaAny = prisma as any
      const orderLines = await prismaAny.orderLine.findMany({
        where: {
          productId: { in: ids },
          order: { status: { in: allActiveStatuses } },
        },
        select: { productId: true, orderedQty: true, deliveredQty: true, order: { select: { status: true } } },
      })

      // outboundReserved: WAVE_ASSIGNED + IN_DELIVERY 的未交货量（不含 CONFIRMED，因为已从 qtyOnHand 扣减）
      const outboundMap = new Map<string, number>()
      // lockedQty: 所有活跃状态订单锁定的总量（CONFIRMED + WAVE_ASSIGNED + IN_DELIVERY）
      const lockedMap = new Map<string, number>()
      for (const l of orderLines as Array<{ productId: string; orderedQty: unknown; deliveredQty: unknown; order: { status: string } }>) {
        const undelivered = toNum(l.orderedQty) - toNum(l.deliveredQty)
        if (undelivered <= 0) continue
        // 所有活跃状态都计入锁定量
        lockedMap.set(l.productId, (lockedMap.get(l.productId) ?? 0) + undelivered)
        // 只有 WAVE_ASSIGNED / IN_DELIVERY 计入 outboundReserved（forecast 差值）
        if (l.order.status !== 'CONFIRMED') {
          outboundMap.set(l.productId, (outboundMap.get(l.productId) ?? 0) + undelivered)
        }
      }

      // 在途采购：未收完的 PO Line
      const poLines = await prismaAny.purchaseOrderLine.findMany({
        where: {
          productId: { in: ids },
          purchaseOrder: { status: { in: ['CONFIRMED', 'PARTIAL'] } },
        },
        select: { productId: true, orderedQty: true, receivedQty: true },
      }).catch(() => [])

      const inboundMap = new Map<string, number>()
      for (const l of poLines as Array<{ productId: string; orderedQty: unknown; receivedQty: unknown }>) {
        const pending = toNum(l.orderedQty) - toNum(l.receivedQty)
        if (pending > 0) inboundMap.set(l.productId, (inboundMap.get(l.productId) ?? 0) + pending)
      }

      const result = products.map(p => {
        const onHand = toNum(p.qtyOnHand)
        const safetyMin = toNum(p.safetyStockMin)
        const inbound = inboundMap.get(p.id) ?? 0
        const outbound = outboundMap.get(p.id) ?? 0
        const locked = lockedMap.get(p.id) ?? 0
        const forecast = onHand + inbound - outbound
        return {
          productId: p.id,
          qtyOnHand: onHand,
          safetyStockMin: safetyMin,
          lockedQty: locked,
          availableQty: onHand - locked,
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
