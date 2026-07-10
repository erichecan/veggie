import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/lots/integrity?productId=X
 * ============================================================================
 * 批次台账 vs 商品库存 一致性核对（信息性，非报警）——
 * Lot 追踪存在已知历史缺口（部分入库/出库未生成批次记录），两者合理地可能不一致，
 * 前端应以中性提示呈现，而非当作错误。
 *
 * 返回：{ productId, qtyOnHand, lotSumAvailable, difference }
 *   qtyOnHand       — Product.qtyOnHand（SSOT 库存数）
 *   lotSumAvailable — Σ currentQty（该商品所有 AVAILABLE 状态批次）
 *   difference      — qtyOnHand - lotSumAvailable
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const productId = searchParams.get('productId')?.trim()
      if (!productId) {
        return NextResponse.json({ error: '请提供 productId 参数' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const product = await p.product.findUnique({
        where: { id: productId },
        select: { id: true, qtyOnHand: true },
      })
      if (!product) {
        return NextResponse.json({ error: '商品不存在' }, { status: 404 })
      }

      const availableLots = await p.lot.findMany({
        where: { productId, status: 'AVAILABLE' },
        select: { currentQty: true },
      })

      const lotSumAvailable = availableLots.reduce(
        (sum: number, l: { currentQty: unknown }) => sum + toNum(l.currentQty),
        0
      )
      const qtyOnHand = toNum(product.qtyOnHand)

      return NextResponse.json(
        serializeApi({
          productId,
          qtyOnHand,
          lotSumAvailable,
          difference: Math.round((qtyOnHand - lotSumAvailable) * 1000) / 1000,
        })
      )
    } catch (error) {
      console.error('[GET /api/lots/integrity]', error)
      return NextResponse.json({ error: '获取批次一致性核对失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
