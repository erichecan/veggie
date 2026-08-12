/**
 * GET /api/goods-receipts/unlinked?days=30&limit=100
 * ============================================================================
 * 「未关联采购单的收货」（台账 E6 验收第三条）。
 *
 * ⚠️ 不要去 GoodsReceipt 表里找 —— `purchaseOrderId` 是**非空外键**，
 * 从收货工作台走的收货必然挂着采购单，那张表里永远查不出未关联记录。
 * 真正会漏的是**绕过收货单直接进库存**的流水：手工调整、数据导入、盘盈。
 * 货实际进来了却没有任何采购依据，这才是需要被看见的东西。
 *
 * 判据见 lib/receipt-linkage.isUnlinkedInbound（白名单反选，新增入库路径若忘了
 * 登记会自动落进这里被发现，而不是静默漏掉）。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { ACCOUNTED_IN_SOURCE_LIST, OPENING_BALANCE_REFS } from '@/lib/receipt-linkage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const days = Math.min(400, Math.max(1, parseInt(searchParams.get('days') ?? '30', 10) || 30))
      const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') ?? '100', 10) || 100))
      const since = new Date(Date.now() - days * 86400000)

      // 入库方向（与 isUnlinkedInbound 同一条规则，只是这里表达成查询条件）
      const inboundWhere = {
        movedAt: { gte: since },
        OR: [{ type: 'IN' as const }, { type: 'ADJUSTMENT' as const, qty: { gt: 0 } }],
      }
      // 「无采购依据」= 来源不在白名单里（含来源为空）。
      // ⚠️ notIn 在 SQL 里会把 NULL 判成 false，必须显式把 sourceType=null 并进来，
      // 否则「压根没写来源」的那些反而查不出来 —— 恰恰是最该被看见的一类。
      const unlinkedWhere = {
        AND: [
          inboundWhere,
          { OR: [{ sourceType: null }, { sourceType: { notIn: [...ACCOUNTED_IN_SOURCE_LIST] } }] },
          // 期初余额排除在外：它是一次性、有标记的建账事件，不是「收了没单的货」。
          // 不排的话本地实测 1583/1650 笔入库都是它，这块提示会永远一片红没人看
          { OR: [{ sourceRef: null }, { sourceRef: { notIn: [...OPENING_BALANCE_REFS] } }] },
        ],
      }

      // ⛔ 计数走 DB，不靠「取 N 条再数一遍」—— 那样一旦超过上限，
      // count 会静默停在上限上，界面显示「200 笔未关联」而真实可能是几千笔。
      // 分母 scanned 同理。列表本身才受 limit 约束，并在响应里说明。
      const [count, scanned, sum, items] = await Promise.all([
        prisma.stockMove.count({ where: unlinkedWhere }),
        prisma.stockMove.count({ where: inboundWhere }),
        prisma.stockMove.aggregate({ where: unlinkedWhere, _sum: { qty: true } }),
        prisma.stockMove.findMany({
          where: unlinkedWhere,
          orderBy: { movedAt: 'desc' },
          take: limit,
          select: {
            id: true, productId: true, productName: true, type: true, qty: true,
            sourceType: true, sourceRef: true, note: true, movedAt: true,
          },
        }),
      ])

      return NextResponse.json(serializeApi({
        days,
        scanned,
        count,
        qty: Math.round(Number(sum._sum.qty ?? 0) * 1000) / 1000,
        /** items 只回前 limit 条；count 是全量，两者不同时别把 items.length 当总数 */
        truncated: count > items.length,
        items,
      }))
    } catch (error) {
      console.error('[GET /api/goods-receipts/unlinked]', error)
      return NextResponse.json({ error: '获取未关联入库失败' }, { status: 500 })
    }
  }, { require: 'stock.receipt.read' })
}
