import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { runBackup } from '@/lib/backup'

const ALLOWED_ROLES = ['BOSS']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const backups = await prisma.backupJob.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
    })
    return NextResponse.json({ backups })
  }, { require: 'system.backup.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const result = await runBackup('MANUAL', user.userId)
      return NextResponse.json({ backup: result })
    } catch (err) {
      const status = (err as { status?: number })?.status ?? 500
      const message = err instanceof Error ? err.message : '备份失败'
      return NextResponse.json({ error: message }, { status })
    }
  }, { require: 'system.backup.manage' })
}
