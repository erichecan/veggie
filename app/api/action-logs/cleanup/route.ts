import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const RETENTION_DAYS = 90

// 需要 CRON_SECRET header 才能执行，防止被随意调用
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)

    const { count } = await prisma.actionLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })

    return NextResponse.json({ deleted: count, cutoff: cutoff.toISOString() })
  } catch (error) {
    console.error('[POST /api/action-logs/cleanup]', error)
    return NextResponse.json({ error: '清理失败' }, { status: 500 })
  }
}
