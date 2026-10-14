import { NextResponse } from 'next/server'
import { runBackup, cleanupExpiredBackups } from '@/lib/backup'
import { runAndRecordLedgerCheck } from '@/lib/ledger-check'

/**
 * /api/cron/backup-database — 每日自动全库备份
 * ============================================================================
 * 触发方式与 app/api/cron/generate-statements/route.ts 一致：外部定时器
 * （Cloud Scheduler）POST 本路由并带 x-cron-secret header。
 * 备份成功后顺带清理超过 30 天的旧备份，不需要单独再配一个 Scheduler job。
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const backup = await runBackup('AUTO')
    const cleanup = await cleanupExpiredBackups()
    // 备份完顺带跑一遍账本核对（20261014 复式改造 L2）：droplet 上已有这个每日 timer，
    // 不为核对另配定时器。核对失败不影响备份结果的返回码——备份才是这个 timer 的本职。
    let ledgerCheck: { id: string; ok: boolean } | { error: string }
    try {
      const run = await runAndRecordLedgerCheck('AUTO')
      ledgerCheck = { id: run.id, ok: run.ok }
    } catch (e) {
      console.error('[cron backup → ledger-check]', e)
      ledgerCheck = { error: e instanceof Error ? e.message : String(e) }
    }
    return NextResponse.json({ backup, cleanup, ledgerCheck })
  } catch (error) {
    console.error('[POST /api/cron/backup-database]', error)
    const message = error instanceof Error ? error.message : '自动备份失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
