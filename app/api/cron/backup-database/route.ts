import { NextResponse } from 'next/server'
import { runBackup, cleanupExpiredBackups } from '@/lib/backup'

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
    return NextResponse.json({ backup, cleanup })
  } catch (error) {
    console.error('[POST /api/cron/backup-database]', error)
    const message = error instanceof Error ? error.message : '自动备份失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
