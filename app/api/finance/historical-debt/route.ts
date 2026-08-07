import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/finance/historical-debt
 *
 * 返回每个客户的「上期未清余额」（历史欠款），来源为该客户最近一张
 * 已确认 / 已发送（confirmed / sent）对账单的 closingBalance。
 *
 * 这是财务总览页历史欠款的权威数据源，替代旧的 MOCK_HISTORICAL_DEBT。
 *
 * 返回格式：{ [customerId]: number }，仅包含余额非 0 的客户。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      // distinct + orderBy：每个 customerId 取 periodEnd 最新的一条
      const statements = await prisma.statement.findMany({
        where: { status: { in: ['confirmed', 'sent'] } },
        orderBy: [{ customerId: 'asc' }, { periodEnd: 'desc' }],
        distinct: ['customerId'],
        select: { customerId: true, closingBalance: true },
      })

      const map: Record<string, number> = {}
      for (const s of statements) {
        const bal = toNum(s.closingBalance)
        if (bal > 0) map[s.customerId] = bal
      }

      return NextResponse.json(map)
    } catch (error) {
      console.error('[GET /api/finance/historical-debt]', error)
      return NextResponse.json({ error: '获取历史欠款失败' }, { status: 500 })
    }
  }, { require: 'finance.account.read' })
}
