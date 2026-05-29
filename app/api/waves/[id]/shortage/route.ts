import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * P0-1: 批次级缺货预警
 * GET /api/waves/:id/shortage
 *
 * 算法：
 *   1. 查询该波次包含的 orderIds
 *   2. 查这些订单中 status IN (CONFIRMED, WAVE_ASSIGNED) 的 OrderLine
 *   3. 按 productId 聚合 orderedQty（需求量）
 *   4. 查 Product.qtyOnHand（库存）
 *   5. shortageQty = max(0, demandQty - qtyOnHand)
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
        },
      })

      // 3. 按 productId 聚合需求量
      const demandMap = new Map<string, { productName: string; demandQty: number }>()
      for (const line of orderLines) {
        const existing = demandMap.get(line.productId)
        if (existing) {
          existing.demandQty += toNum(line.orderedQty)
        } else {
          demandMap.set(line.productId, {
            productName: line.productName,
            demandQty: toNum(line.orderedQty),
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
        const shortageQty = Math.max(0, demand.demandQty - stockQty)
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
