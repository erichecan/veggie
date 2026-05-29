import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const statusFilter = searchParams.get('status')?.toUpperCase()
    const where = statusFilter ? { status: statusFilter as never } : {}
    const products = await prisma.product.findMany({
      where,
      orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
      include: { template: { select: { images: true, uomId: true, uom: { select: { id: true, name: true } }, customerTaxRate: true } } },
    })
    // 商品自身没有图片时使用模板图片；同时把模板 UoM 提升到顶层
    // customerTaxRate：变体自身可空，兜底用模板的值
    const result = products.map(({ template, ...p }) => ({
      ...p,
      images: (p.images as string[]).length > 0
        ? p.images
        : (template?.images ?? []),
      uomId:          template?.uom?.id   ?? template?.uomId ?? null,
      uomName:        template?.uom?.name ?? null,
      customerTaxRate: p.customerTaxRate ?? template?.customerTaxRate ?? 0,
    }))
    return NextResponse.json(serializeApi(result))
  } catch (error) {
    console.error('[GET /api/products]', error)
    return NextResponse.json({ error: '获取商品失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const product = await prisma.product.create({
        data: {
          ...data,
          status: data.status?.toUpperCase() ?? 'ACTIVE',
          variantAttributes: data.variantAttributes ?? [],
          images: data.images ?? [],
        },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product', resourceId: product.id,
        detail: `创建商品: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(product), { status: 201 })
    } catch (error) {
      console.error('[POST /api/products]', error)
      return NextResponse.json({ error: '创建商品失败' }, { status: 500 })
    }
  })
}
