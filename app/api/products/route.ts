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
    // sellable=1：只给下单/报价单/销售单选品用，只返回 canBeSold 的商品（该标记在 ProductTemplate 上）
    const sellableOnly = searchParams.get('sellable') === '1'
    const where: Record<string, unknown> = {}
    if (statusFilter) where.status = statusFilter as never
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }
    const templateWhere: Record<string, unknown> = {}
    if (purchasableOnly) templateWhere.canBePurchased = true
    if (sellableOnly) templateWhere.canBeSold = true
    if (Object.keys(templateWhere).length > 0) where.template = templateWhere

    // ?slim=1 → 只回选品下拉框真正会用到的字段。
    // 全量版一次 3.5 MB（5,479 个商品 × 全字段），而它被 8+ 个页面在加载时调用，
    // 光是序列化就把单线程的事件循环占住。命名与 /api/customers?slim=1 保持一致。
    // ⛔ 不传 slim 时字段与改造前逐字相同 —— 现有调用方不受影响。
    const slim = searchParams.get('slim') === '1'
    if (slim) {
      const rows = await prisma.product.findMany({
        where,
        orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true, templateId: true, name: true, internalRef: true, spec: true,
          listPrice: true, price: true, standardPrice: true, qtyOnHand: true,
          customerTaxRate: true, status: true, categoryId: true,
          // images 留着：实测全库 5,480 条**全是空数组**，总共才 74 KB，
          // 但少了它下单页就没法显示商品图，得为一个字段再开一套接口。
          images: true,
          category: { select: { name: true } },
          template: {
            select: {
              images: true,
              uomId: true, uom: { select: { id: true, name: true } },
              customerTaxRate: true, internalRef: true,
              category: { select: { name: true } },
              canBeSold: true, canBePurchased: true, purchaseUomId: true,
            },
          },
        },
      })
      const slimResult = rows.map(({ template, category, ...p }) => ({
        ...p,
        images: (p.images as string[]).length > 0 ? p.images : (template?.images ?? []),
        uomId:           template?.uom?.id   ?? template?.uomId ?? null,
        uomName:         template?.uom?.name ?? null,
        purchaseUomId:   template?.purchaseUomId ?? null,
        customerTaxRate: p.customerTaxRate ?? template?.customerTaxRate ?? 0,
        internalRef:     p.internalRef ?? template?.internalRef ?? null,
        category:        category?.name ?? template?.category?.name ?? null,
        canBeSold:       template?.canBeSold ?? true,
        canBePurchased:  template?.canBePurchased ?? true,
      }))
      return NextResponse.json(serializeApi(slimResult))
    }

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
  }, { require: 'master.product.create' })
}
