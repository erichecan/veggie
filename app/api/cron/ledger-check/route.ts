import { NextResponse } from 'next/server'
import { runAndRecordLedgerCheck } from '@/lib/ledger-check'

/**
 * /api/cron/ledger-check — 每日账本核对（20261014 复式改造 L2）
 * ============================================================================
 * 与其它 /api/cron/* 一样：任何定时器 POST 本路由并带 x-cron-secret 即可触发，
 * 不依赖任何云平台调度。平时由 /api/cron/backup-database 备份完顺带调用，
 * 不需要在 droplet 上另配 timer；单独开放出来是为了手工补跑/排查。
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const run = await runAndRecordLedgerCheck('AUTO')
    return NextResponse.json({ id: run.id, ok: run.ok, durationMs: run.durationMs })
  } catch (error) {
    console.error('[POST /api/cron/ledger-check]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : '账本核对失败' }, { status: 500 })
  }
}
