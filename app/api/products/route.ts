import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { buildProductTemplatesWhere, productStockAlertCounts, PRODUCT_TEMPLATE_ORDER_BY } from '@/lib/products-query'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)

    // 商品管理列表页(?page=...)：分页/分面/库存告警，where 构造与导出
    // (/api/export/product-templates) 共用同一份 lib/products-query.ts，保证屏幕与导出口径一致。
    // 20260825 合表重构前这条路径在已删除的 GET /api/product-templates 上，现搬回 /api/products。
    if (searchParams.has('page')) {
      const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
      const rawSize = searchParams.get('pageSize') ?? searchParams.get('limit') ?? '20'
      const limit = Math.min(200, Math.max(1, parseInt(rawSize, 10)))
      const [where, alertCounts] = await Promise.all([
        buildProductTemplatesWhere(searchParams),
        productStockAlertCounts(),
      ])
      const [total, products] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          include: { uom: true },
          orderBy: PRODUCT_TEMPLATE_ORDER_BY,
          skip: (page - 1) * limit,
          take: limit,
        }),
      ])
      const serialized = serializeApi(products)
      return NextResponse.json({
        data: serialized, items: serialized, total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
        alertCounts,
      })
    }

    const statusFilter = searchParams.get('status')?.toUpperCase()
    const search = searchParams.get('search')?.trim()
    // purchasable=1：只给采购模块选品用，只返回 canBePurchased 的商品
    const purchasableOnly = searchParams.get('purchasable') === '1'
    // sellable=1：只给下单/报价单/销售单选品用，只返回 canBeSold 的商品
    const sellableOnly = searchParams.get('sellable') === '1'
    // templateType=PRODUCT：只要实物商品（报废/批次这类只对实物有意义）。
    const templateType = searchParams.get('templateType')?.toUpperCase()
    const where: Record<string, unknown> = {}
    if (statusFilter) where.status = statusFilter as never
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (purchasableOnly) where.canBePurchased = true
    if (sellableOnly) where.canBeSold = true
    if (templateType) where.type = templateType

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
          id: true, name: true, internalRef: true, spec: true, saleDescription: true,
          listPrice: true, price: true, standardPrice: true, qtyOnHand: true,
          customerTaxRate: true, vendorTaxRate: true, status: true, categoryId: true,
          // images 留着：实测全库 5,480 条**全是空数组**，总共才 74 KB，
          // 但少了它下单页就没法显示商品图，得为一个字段再开一套接口。
          images: true,
          category: { select: { name: true } },
          uomId: true, uom: { select: { id: true, name: true } },
          purchaseUomId: true, purchaseUom: { select: { id: true, name: true } },
          canBeSold: true, canBePurchased: true,
        },
      })
      const slimResult = rows.map(({ category, uom, purchaseUom, ...p }) => ({
        ...p,
        uomName: uom?.name ?? null,
        // 采购单位名——之前只取了裸 purchaseUomId 没 join 名字，采购单页面拿不到显示文本
        purchaseUomName: purchaseUom?.name ?? null,
        category: category?.name ?? null,
      }))
      return NextResponse.json(serializeApi(slimResult))
    }

    const products = await prisma.product.findMany({
      where,
      orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
      include: {
        category: { select: { name: true } },
        uom: { select: { id: true, name: true } },
      },
    })
    const result = products.map(({ category, uom, ...p }) => ({
      ...p,
      uomName: uom?.name ?? null,
      category: category?.name ?? null,
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
      // saleUoms 不是 Product 自身字段（关系名同名，直接透传会被 Prisma 当成嵌套写入报错）——
      // 商品详情页新建流程创建后另调 PUT /api/products/[id]/sale-uoms 落库。
      const { saleUoms: _saleUoms, ...data } = await req.json()
      const product = await prisma.product.create({
        data: {
          ...data,
          status: data.status?.toUpperCase() ?? 'ACTIVE',
          // 商品详情页新建流程的 tmpl.type 是小写('product'/'consu'/'service')，枚举必须大写。
          type: data.type !== undefined ? String(data.type).toUpperCase() : undefined,
          variantAttributes: data.variantAttributes ?? [],
          images: data.images ?? [],
          createdBy: user.name || user.email,
          updatedBy: user.name || user.email,
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
