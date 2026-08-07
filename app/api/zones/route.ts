import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const zones = await prisma.zone.findMany({ orderBy: { key: 'asc' } })
      return NextResponse.json(serializeApi(zones))
    } catch (error) {
      console.error('[GET /api/zones]', error)
      return NextResponse.json({ error: '获取温区列表失败' }, { status: 500 })
    }
  }, { require: 'stock.zone.read' })
}
