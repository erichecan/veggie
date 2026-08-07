import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const cats = await p.uomCategory.findMany({
      orderBy: { name: 'asc' },
      include: { uoms: { where: { active: true }, orderBy: { factor: 'asc' } } },
    })
    return NextResponse.json(serializeApi(cats))
  } catch (error) {
    console.error('[GET /api/uom-categories]', error)
    return NextResponse.json({ error: '获取 UoM Category 失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const name = String(data.name ?? '').trim()
      if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const created = await p.uomCategory.create({
        data: { name, nameZh: data.nameZh ?? null },
      })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      console.error('[POST /api/uom-categories]', error)
      return NextResponse.json({ error: '创建失败' }, { status: 500 })
    }
  }, { require: 'master.uom_category.create' })
}
