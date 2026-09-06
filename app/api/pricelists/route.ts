import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET() {
  try {
    const pricelists = await prisma.odooPricelist.findMany({ orderBy: { sequence: 'asc' } })
    return NextResponse.json(serializeApi(pricelists))
  } catch (error) {
    console.error('[GET /api/pricelists]', error)
    return NextResponse.json({ error: '获取价格表失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { id: _ignoredId, ...data } = await req.json()
      if (!data.name || !String(data.name).trim()) {
        return NextResponse.json({ error: '价格表名称不能为空' }, { status: 400 })
      }
      const pricelist = await prisma.odooPricelist.create({
        data: { ...data, items: data.items ?? [] },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'pricelist', resourceId: pricelist.id,
        detail: `创建价格表: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(pricelist), { status: 201 })
    } catch (error) {
      console.error('[POST /api/pricelists]', error)
      return NextResponse.json({ error: '创建价格表失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.create' })
}
