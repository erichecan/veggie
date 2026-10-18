import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/products/[id]/purchase-receipt-history —— 商品 Cost 旁"历史收货"弹窗数据源
 * （20261015 客户反馈：点时钟图标想看"哪个供应商、哪张单、确认日期、数量、谁经手"）
 * ============================================================================
 * 跟同一个按钮共用的 price-change-log 不是一回事：那个答的是"Cost 字段本身被谁改成过
 * 多少"（编辑历史），这里答的是"这批成本是哪一次收货带来的"（收货历史）。
 *
 * 数据源用 StockMove(sourceType='PURCHASE_RECEIVE')——20261014 复式改造后才有
 * partnerId/createdBy/uomQty 这几列，在此之前的历史收货记录这几列是 null，
 * 前端按供应商/经手人留空处理，不是 bug。
 *
 * confirmedAt 取 PurchaseOrder 自己的字段，不能用 StockMove.movedAt 代替——movedAt
 * = batchDate = po.expectedDate ?? receivedAt，跟"订单确认日期"语义不同。
 */

const HISTORY_LIMIT = 20

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: productId } = await params
  return withAuth(req, async () => {
    try {
      const moves = await prisma.stockMove.findMany({
        where: { productId, sourceType: 'PURCHASE_RECEIVE' },
        orderBy: { movedAt: 'desc' },
        take: HISTORY_LIMIT,
        select: {
          movedAt: true,
          unitCost: true,
          uomQty: true,
          qty: true,
          partnerId: true,
          createdBy: true,
          sourceId: true,
          sourceRef: true,
          purchaseOrderLineId: true,
        },
      })

      const partnerIds = [...new Set(moves.map(m => m.partnerId).filter((v): v is string => !!v))]
      const poIds = [...new Set(moves.map(m => m.sourceId).filter((v): v is string => !!v))]
      const poLineIds = [...new Set(moves.map(m => m.purchaseOrderLineId).filter((v): v is string => !!v))]

      const [partners, purchaseOrders, poLines] = await Promise.all([
        partnerIds.length
          ? prisma.customer.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })
          : Promise.resolve([]),
        poIds.length
          ? prisma.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, name: true, confirmedAt: true, vendorReference: true } })
          : Promise.resolve([]),
        poLineIds.length
          ? prisma.purchaseOrderLine.findMany({ where: { id: { in: poLineIds } }, select: { id: true, bestBefore: true } })
          : Promise.resolve([]),
      ])
      const partnerNameById = new Map(partners.map(p => [p.id, p.name]))
      const poById = new Map(purchaseOrders.map(p => [p.id, p]))
      const poLineById = new Map(poLines.map(l => [l.id, l]))

      const history = moves.map(m => {
        const po = m.sourceId ? poById.get(m.sourceId) : undefined
        const poLine = m.purchaseOrderLineId ? poLineById.get(m.purchaseOrderLineId) : undefined
        return {
          supplierName: m.partnerId ? (partnerNameById.get(m.partnerId) ?? null) : null,
          poName: po?.name ?? m.sourceRef ?? null,
          supplierRef: po?.vendorReference ?? null,
          confirmedAt: po?.confirmedAt?.toISOString() ?? null,
          qty: toNum(m.uomQty ?? m.qty),
          unitCost: m.unitCost != null ? toNum(m.unitCost) : null,
          bestBefore: poLine?.bestBefore?.toISOString() ?? null,
          updatedBy: m.createdBy ?? null,
          movedAt: m.movedAt.toISOString(),
        }
      })

      return NextResponse.json({ history })
    } catch (error) {
      console.error('[GET /api/products/[id]/purchase-receipt-history]', error)
      return NextResponse.json({ error: '获取收货历史失败' }, { status: 500 })
    }
  }, { require: 'master.product.read_price_history' })
}
