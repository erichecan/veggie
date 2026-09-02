import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { computeIncomeStatement, type JournalLineForIncomeStatement } from '@/lib/analytics/income-statement'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/income-statement — 利润表（毛利口径）
 * ============================================================================
 * GET ?from&to
 * 口径与已知现状见 lib/analytics/income-statement.ts 顶部注释。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))

      const lines = await prisma.journalEntryLine.findMany({
        where: {
          entry: { status: 'POSTED', date: { gte: start, lt: end } },
          account: { type: { in: ['INCOME', 'EXPENSE'] } },
        },
        select: {
          debit: true,
          credit: true,
          account: { select: { type: true } },
        },
      })

      const rows: JournalLineForIncomeStatement[] = lines.map((l) => ({
        accountType: l.account.type as 'INCOME' | 'EXPENSE',
        debit: Number(l.debit),
        credit: Number(l.credit),
      }))

      const result = computeIncomeStatement(rows)

      const postedEntryCount = await prisma.journalEntry.count({
        where: { status: 'POSTED', date: { gte: start, lt: end } },
      })

      return NextResponse.json(serializeApi({
        periodFrom: searchParams.get('from') ?? null,
        periodTo: searchParams.get('to') ?? null,
        ...result,
        posted: { journalEntryCount: postedEntryCount },
      }))
    } catch (error) {
      console.error('[GET /api/analytics/income-statement]', error)
      return NextResponse.json({ error: '获取利润表失败' }, { status: 500 })
    }
  }, { require: 'analytics.finance.read' })
}
