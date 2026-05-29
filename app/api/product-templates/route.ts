import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    // Accept both ?pageSize=N (new) and ?limit=N (legacy); default 20
    const rawSize = searchParams.get('pageSize') ?? searchParams.get('limit') ?? '20'
    // 上限 5000：pricelist item 弹窗要列出全部 ~1700 条商品供选择
    const limit = Math.min(5000, Math.max(1, parseInt(rawSize, 10)))
    const search = searchParams.get('search') ?? ''
    const status = searchParams.get('status') ?? ''

    const where: Record<string, unknown> = {}
    if (status && status !== 'all') where.status = status.toUpperCase()
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [total, templates] = await Promise.all([
      prisma.productTemplate.count({ where }),
      prisma.productTemplate.findMany({
        where,
        include: { uom: true },
        orderBy: [{ status: 'asc' }, { sequence: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    const serialized = serializeApi(templates)
    return NextResponse.json({ data: serialized, items: serialized, total, page, pageSize: limit, totalPages: Math.ceil(total / limit) })
  } catch (error) {
    console.error('[GET /api/product-templates]', error)
    return NextResponse.json({ error: '获取商品模板失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const template = await prisma.productTemplate.create({
        data: {
          ...data,
          type: data.type?.toUpperCase() ?? 'PRODUCT',
          status: data.status?.toUpperCase() ?? 'DRAFT',
          attributeLines: data.attributeLines ?? [],
          images: data.images ?? [],
        },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product-template', resourceId: template.id,
        detail: `创建商品模板: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(template), { status: 201 })
    } catch (error) {
      console.error('[POST /api/product-templates]', error)
      return NextResponse.json({ error: '创建商品模板失败' }, { status: 500 })
    }
  })
}
