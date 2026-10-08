import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { normalizeItems } from '@/lib/pricelist-item'

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
      // items 走跟 PUT 同一套校验+归一化(缺 id 的补上)——列表页「复制」只传规则内容不带 id
      const pricelist = await prisma.odooPricelist.create({
        data: { ...data, externalId: data.externalId || null, items: normalizeItems(data.items ?? []) as unknown as object[] },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'pricelist', resourceId: pricelist.id,
        detail: `创建价格表: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(pricelist), { status: 201 })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status === 400) return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 })
      console.error('[POST /api/pricelists]', error)
      return NextResponse.json({ error: '创建价格表失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.create' })
}
