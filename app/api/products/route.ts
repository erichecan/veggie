import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const statusFilter = searchParams.get('status')?.toUpperCase()
    const search = searchParams.get('search')?.trim()
    // purchasable=1：只给采购模块选品用，只返回 canBePurchased 的商品（该标记在 ProductTemplate 上）
    const purchasableOnly = searchParams.get('purchasable') === '1'
    const where: Record<string, unknown> = {}
    if (statusFilter) where.status = statusFilter as never
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (purchasableOnly) where.template = { canBePurchased: true }
    const products = await prisma.product.findMany({
      where,
      orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
      include: {
        category: { select: { name: true } },
        template: { select: { images: true, uomId: true, uom: { select: { id: true, name: true } }, customerTaxRate: true, internalRef: true, category: { select: { name: true } }, canBeSold: true, canBePurchased: true, purchaseUomId: true } },
      },
    })
    // 商品自身没有图片时使用模板图片；同时把模板 UoM 提升到顶层
    // customerTaxRate / internalRef / category：变体自身可空，兜底用模板的值
    const result = products.map(({ template, category, ...p }) => ({
      ...p,
      images: (p.images as string[]).length > 0
        ? p.images
        : (template?.images ?? []),
      uomId:           template?.uom?.id   ?? template?.uomId ?? null,
      uomName:         template?.uom?.name ?? null,
      purchaseUomId:   template?.purchaseUomId ?? null,
      customerTaxRate: p.customerTaxRate ?? template?.customerTaxRate ?? 0,
      internalRef:     p.internalRef ?? template?.internalRef ?? null,
      category:        category?.name ?? template?.category?.name ?? null,
      canBeSold:       template?.canBeSold ?? true,
      canBePurchased:  template?.canBePurchased ?? true,
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
