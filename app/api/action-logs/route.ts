import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'

const PAGE_SIZE = 20

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const resource = searchParams.get('resource')
    const resourceId = searchParams.get('resourceId')
    const skip = parseInt(searchParams.get('skip') ?? '0')
    const take = Math.min(parseInt(searchParams.get('take') ?? String(PAGE_SIZE)), 100)

    const where = {
      ...(resource ? { resource } : {}),
      ...(resourceId ? { resourceId } : {}),
    }

    const [logs, total] = await Promise.all([
      prisma.actionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.actionLog.count({ where }),
    ])

    return NextResponse.json(serializeApi({ logs, total, hasMore: skip + take < total }))
  } catch (error) {
    console.error('[GET /api/action-logs]', error)
    return NextResponse.json({ error: '获取日志失败' }, { status: 500 })
  }
}
