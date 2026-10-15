import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'
import { untakenOrderDemand } from '@/lib/order-stock'

/**
 * P0-1: 批次级缺货预警
 * GET /api/waves/:id/shortage
 *
 * 算法：
 *   1. 查询该波次包含的 orderIds
 *   2. 查这些订单中 status IN (CONFIRMED, WAVE_ASSIGNED) 的 OrderLine
 *   3. 按 productId 聚合 orderedQty（需求量）
 *   4. 查 Product.qtyOnHand（库存）
 *   5. shortageQty = min(需求, max(0, 未扣库存的需求 − qtyOnHand))
 *      ⛔ 20261014 修：以前是 max(0, 需求 − qtyOnHand)。订单确认时已从 qtyOnHand 扣过，
 *      再减一次 → 库存 100、确认 60 后在手 40，却报「缺 20」。qtyOnHand 为负（已超卖）才是真缺货。
 *      需求也换算成基础单位（以前按箱下单的行直接加箱数）。
 *   6. 只返回 shortageQty > 0 的产品
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    try {
      const { id } = await params

      // 1. 查波次
      const wave = await prisma.pickingWave.findUnique({
        where: { id },
        select: { id: true, orderIds: true, status: true },
      })
      if (!wave) {
        return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      }
      if (wave.orderIds.length === 0) {
        return NextResponse.json({ shortages: [], summary: { totalProducts: 0, shortageProducts: 0, shortageRate: 0 } })
      }

      // 2. 查这些订单中状态为 CONFIRMED / WAVE_ASSIGNED 的 OrderLine
      const orderLines = await prisma.orderLine.findMany({
        where: {
          orderId: { in: wave.orderIds },
          order: { status: { in: ['CONFIRMED', 'WAVE_ASSIGNED'] } },
        },
        select: {
          productId: true,
          productName: true,
          orderedQty: true,
          uomId: true,
        },
      })

      // 3. 按 productId 聚合需求量
      const demandMap = new Map<string, { productName: string; demandQty: number }>()
      for (const line of orderLines) {
        const existing = demandMap.get(line.productId)
        const stockQty = await toStockQty(prisma as never, line.productId, toNum(line.orderedQty), line.uomId)
        if (existing) {
          existing.demandQty += stockQty
        } else {
          demandMap.set(line.productId, {
            productName: line.productName,
            demandQty: stockQty,
          })
        }
      }

      if (demandMap.size === 0) {
        return NextResponse.json({ shortages: [], summary: { totalProducts: 0, shortageProducts: 0, shortageRate: 0 } })
      }

      // 4. 批量查 Product.qtyOnHand
      const productIds = Array.from(demandMap.keys())
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, qtyOnHand: true },
      })
      const stockMap = new Map(products.map(p => [p.id, toNum(p.qtyOnHand)]))
      const untaken = await untakenOrderDemand(prisma, productIds, { id: { in: wave.orderIds } })

      // 5. 计算缺货
      const shortages: Array<{
        productId: string
        productName: string
        demandQty: number
        stockQty: number
        shortageQty: number
        shortageRate: number
      }> = []

      for (const [productId, demand] of demandMap.entries()) {
        const stockQty = stockMap.get(productId) ?? 0
        const shortageQty = Math.round(Math.min(demand.demandQty, Math.max(0, (untaken.get(productId) ?? 0) - stockQty)) * 1000) / 1000
        if (shortageQty > 0) {
          shortages.push({
            productId,
            productName: demand.productName,
            demandQty: demand.demandQty,
            stockQty,
            shortageQty,
            shortageRate: demand.demandQty > 0
              ? shortageQty / demand.demandQty
              : 0,
          })
        }
      }

      // 按缺货率降序
      shortages.sort((a, b) => b.shortageRate - a.shortageRate)

      const summary = {
        totalProducts: demandMap.size,
        shortageProducts: shortages.length,
        shortageRate: demandMap.size > 0
          ? shortages.length / demandMap.size
          : 0,
      }

      return NextResponse.json(serializeApi({ shortages, summary }))
    } catch (error) {
      console.error('[GET /api/waves/[id]/shortage]', error)
      return NextResponse.json({ error: '获取缺货信息失败' }, { status: 500 })
    }
  })
}
