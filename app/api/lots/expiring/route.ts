import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const days = Math.min(90, Math.max(1, parseInt(searchParams.get('days') ?? '3', 10)))
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))

    const now = new Date()
    const cutoff = new Date(now.getTime() + days * 86400000)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const lots = await p.lot.findMany({
      where: {
        bestBefore: { not: null, lte: cutoff },
        currentQty: { gt: 0 },
        status: 'AVAILABLE',
      },
      orderBy: { bestBefore: 'asc' },
      take: limit,
      include: {
        product: { select: { id: true, name: true, spec: true } },
      },
    })

    const result = lots.map((lot: Record<string, unknown> & { bestBefore: Date }) => ({
      ...lot,
      isExpired: lot.bestBefore < now,
      daysRemaining: Math.ceil((lot.bestBefore.getTime() - now.getTime()) / 86400000),
    }))

    return NextResponse.json(serializeApi(result))
  } catch (error) {
    console.error('[GET /api/lots/expiring]', error)
    return NextResponse.json({ error: '获取临期批次失败' }, { status: 500 })
  }
}
