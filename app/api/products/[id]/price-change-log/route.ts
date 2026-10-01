import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

/**
 * GET /api/products/[id]/price-change-log —— 商品 Sales Price / Cost 价格变更历史
 * （20261001 客户反馈 #22）
 * ============================================================================
 * ⚠️ 路径特意不叫 `price-history`——那个名字已经被 /api/products/[id]/price-history
 * 占用了，是采购单新建页"查看价格历史"弹窗的数据源（按供应商查历史成交进价，见
 * PurchaseRecord/PurchaseOrderLine），跟这里要做的"这个商品的牌价/成本价字段本身
 * 什么时候被谁改过"完全是两件事，第一版实现时手滑直接覆盖过那个文件，已经改回来，
 * 这里另起一个不冲突的路径。
 *
 * 不新建表：价格变动早就落在 ActionLog 里（单条编辑页 PUT /api/products/[id] 的
 * diffChanges、批量导入的逐条 writeLog，见 app/api/products/bulk/route.ts），
 * 这里只是把同一个商品的历史记录按 listPrice/standardPrice 两个字段分别摘出来，
 * 按时间倒序给前端画一条"什么时候、谁、改成了多少"的时间线。
 *
 * ActionLog.changes 是整条编辑/导入事件的全量 diff（可能同时含 name/status 等
 * 其它字段），这里只挑含 listPrice 或 standardPrice 键的那些行。
 * changes 字段值在落库时经过 JSON 序列化，Prisma Decimal 会变成字符串形式的数字
 * （如 "12.50"），读出来要 Number() 转一道。
 */

const HISTORY_LIMIT = 500

interface PriceHistoryEntry {
  value: number
  changedAt: string
  changedBy: string
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const logs = await prisma.actionLog.findMany({
        where: { resource: 'product', resourceId: id, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { changes: true, createdAt: true, userName: true, userEmail: true },
      })

      const listPrice: PriceHistoryEntry[] = []
      const standardPrice: PriceHistoryEntry[] = []

      for (const log of logs) {
        const changes = log.changes as Record<string, { before: unknown; after: unknown }> | null
        if (!changes) continue
        const changedBy = log.userName || log.userEmail || '—'
        const changedAt = log.createdAt.toISOString()

        if (changes.listPrice && changes.listPrice.after != null) {
          listPrice.push({ value: Number(changes.listPrice.after), changedAt, changedBy })
        }
        if (changes.standardPrice && changes.standardPrice.after != null) {
          standardPrice.push({ value: Number(changes.standardPrice.after), changedAt, changedBy })
        }
      }

      return NextResponse.json({ listPrice, standardPrice })
    } catch (error) {
      console.error('[GET /api/products/[id]/price-change-log]', error)
      return NextResponse.json({ error: '获取价格历史失败' }, { status: 500 })
    }
  }, { require: 'master.product.read_price_history' })
}
