import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { runAndRecordLedgerCheck } from '@/lib/ledger-check'

/**
 * /api/finance/ledger-check —— 账本核对结果（20261014 复式改造 L2）
 * GET            最近 30 次（不含明细）+ 最新一次的完整结果；?id= 取指定一次的完整结果
 * POST           立即核对一次（只读，写一行 LedgerCheckRun）
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const id = new URL(req.url).searchParams.get('id')
      const runs = await prisma.ledgerCheckRun.findMany({
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, trigger: true, ok: true, durationMs: true, createdBy: true, createdAt: true },
      })
      const targetId = id ?? runs[0]?.id
      const current = targetId ? await prisma.ledgerCheckRun.findUnique({ where: { id: targetId } }) : null
      return NextResponse.json(serializeApi({ runs, current }))
    } catch (error) {
      console.error('[GET /api/finance/ledger-check]', error)
      return NextResponse.json({ error: '获取核对结果失败' }, { status: 500 })
    }
  }, { require: 'finance.account.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const run = await runAndRecordLedgerCheck('MANUAL', user.name ?? user.email)
      return NextResponse.json(serializeApi(run), { status: 201 })
    } catch (error) {
      console.error('[POST /api/finance/ledger-check]', error)
      return NextResponse.json({ error: '账本核对失败' }, { status: 500 })
    }
  }, { require: 'finance.account.read' })
}
