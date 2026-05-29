import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * /api/accounts - 科目表
 */
export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const accounts = await p.account.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
    })
    return NextResponse.json(serializeApi(accounts))
  } catch (error) {
    console.error('[GET /api/accounts]', error)
    return NextResponse.json({ error: '获取科目表失败' }, { status: 500 })
  }
}

/**
 * GET /api/accounts/ledger?code=1100&from=2026-01-01&to=2026-12-31
 * 返回该科目在指定日期范围内的所有凭证行 + 期初/期末余额
 */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const { code, from, to } = await req.json()
      if (!code) return NextResponse.json({ error: '缺少科目 code' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const account = await p.account.findUnique({ where: { code } })
      if (!account) return NextResponse.json({ error: '科目不存在' }, { status: 404 })

      const dateFilter: Record<string, unknown> = {}
      if (from) dateFilter.gte = new Date(from)
      if (to)   dateFilter.lte = new Date(to)

      const lines = await p.journalEntryLine.findMany({
        where: {
          accountId: account.id,
          entry: {
            status: 'POSTED',
            ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
          },
        },
        include: { entry: true },
        orderBy: { entry: { date: 'asc' } },
      })

      let balance = 0
      const enriched = lines.map((l: Record<string, unknown>) => {
        const d = toNum(l.debit)
        const c = toNum(l.credit)
        balance += d - c
        return {
          entryName: (l.entry as { name: string }).name,
          date:      (l.entry as { date: Date }).date,
          narration: (l.entry as { narration: string }).narration,
          description: l.description,
          debit: d, credit: c, balance,
        }
      })

      return NextResponse.json({
        account: { code: account.code, name: account.name, nameZh: account.nameZh, type: account.type },
        lines: enriched,
        totalDebit: enriched.reduce((s: number, x: { debit: number }) => s + x.debit, 0),
        totalCredit: enriched.reduce((s: number, x: { credit: number }) => s + x.credit, 0),
        closingBalance: balance,
      })
    } catch (error) {
      console.error('[POST /api/accounts ledger]', error)
      return NextResponse.json({ error: '总账查询失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
