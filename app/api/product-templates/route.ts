import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { validateSaleUomItems, normalizeFactor, type SaleUomItemInput } from '@/lib/sale-uom'
import {
  buildProductTemplatesWhere,
  productStockAlertCounts,
  PRODUCT_TEMPLATE_ORDER_BY,
  attachQtyOnHand,
} from '@/lib/products-query'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    // Accept both ?pageSize=N (new) and ?limit=N (legacy); default 20
    const rawSize = searchParams.get('pageSize') ?? searchParams.get('limit') ?? '20'
    const limit = Math.min(200, Math.max(1, parseInt(rawSize, 10)))

    // 筛选口径抽在 lib/products-query.ts，导出路由(/api/export/product-templates)
    // 用的是同一个函数 —— 导出与屏幕分叉在结构上被堵死。改筛选条件只改那一处。
    const [where, alertCounts] = await Promise.all([
      buildProductTemplatesWhere(searchParams),
      productStockAlertCounts(),
    ])

    const [total, templates] = await Promise.all([
      prisma.productTemplate.count({ where }),
      prisma.productTemplate.findMany({
        where,
        include: { uom: true },
        orderBy: PRODUCT_TEMPLATE_ORDER_BY,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    // 当前页每个模板的实时在手库存(只查这一页涉及的 templateId，不用全表 variantMap)
    const serialized = await attachQtyOnHand(serializeApi(templates) as Array<Record<string, unknown>>)

    return NextResponse.json({
      data: serialized, items: serialized, total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
      alertCounts,
    })
  } catch (error) {
    console.error('[GET /api/product-templates]', error)
    return NextResponse.json({ error: '获取商品模板失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { saleUoms: rawSaleUoms, ...data } = await req.json()

      const rawList: SaleUomItemInput[] = Array.isArray(rawSaleUoms) ? rawSaleUoms : []
      // 基准单位单一入口(20260823)：谁是基础行由页头选的 data.uomId 派生（同下方 createMany 的口径），
      // 换基准单位后新变成基础的那一行系数可能还留着旧值 —— 校验前先归一，而不是拿一个用户
      // 没机会去改的旧数字挡住创建。
      const templateUomIdForValidation = data.uomId ? String(data.uomId) : null
      const saleUoms: SaleUomItemInput[] = templateUomIdForValidation
        ? rawList.map(it => {
          const isDefault = String(it.uomId) === templateUomIdForValidation
          return { ...it, isDefault, factor: isDefault ? 1 : it.factor }
        })
        : rawList
      const saleUomsError = saleUoms.length > 0 ? validateSaleUomItems(saleUoms) : null
      if (saleUomsError) return NextResponse.json({ error: saleUomsError }, { status: 400 })

      // 系统约定商品必须挂模板（同 /api/products/bulk、/api/products/quick-create）：
      // 同一事务里把 ProductTemplate + 主变体 Product 一起建好，否则编辑页找不到
      // primaryProductId，"可售单位(大小单位)"区块永远不出现（20260728 排查确认）。
      // 新建时顺手带上的 saleUoms 也在这同一个事务里落库，不用等保存后跳到编辑页再配一次。
      const template = await prisma.$transaction(async tx => {
        const tpl = await tx.productTemplate.create({
          data: {
            ...data,
            type: data.type?.toUpperCase() ?? 'PRODUCT',
            status: data.status?.toUpperCase() ?? 'DRAFT',
            attributeLines: data.attributeLines ?? [],
            images: data.images ?? [],
          },
        })
        const product = await tx.product.create({
          data: {
            templateId: tpl.id,
            name: tpl.name,
            internalRef: data.internalRef,
            categoryId: data.categoryId,
            listPrice: data.listPrice,
            standardPrice: data.standardPrice,
            customerTaxRate: data.customerTaxRate,
            commissionPrice: data.commissionPrice,
            images: data.images ?? [],
            status: data.status?.toUpperCase() ?? 'DRAFT',
          },
        })
        if (saleUoms.length > 0) {
          // 基准单位单一入口(20260823)：谁是基础行由页头选的 data.uomId 派生，
          // 不再信 saleUoms 里各行自带的 isDefault —— 新建场景两者理论上应该一致，
          // 这里是保险，不是预期会分叉。
          const templateUomId = data.uomId ? String(data.uomId) : null
          await tx.productSaleUom.createMany({
            data: saleUoms.map(it => {
              const isDefault = templateUomId ? String(it.uomId) === templateUomId : !!it.isDefault
              return {
                productId: product.id,
                uomId: String(it.uomId),
                isDefault,
                // 基础单位对自己的换算恒为 1（见 lib/sale-uom.ts）
                factor: isDefault ? 1 : normalizeFactor(it.factor),
                priceOverride: it.priceOverride != null && it.priceOverride !== '' ? Number(it.priceOverride) : null,
                priceMode: it.priceMode === 'FIXED' || it.priceMode === 'FORMULA' ? it.priceMode : 'AUTO',
                priceDiscountPct: it.priceDiscountPct != null && it.priceDiscountPct !== '' ? Number(it.priceDiscountPct) : 0,
                priceSurcharge: it.priceSurcharge != null && it.priceSurcharge !== '' ? Number(it.priceSurcharge) : 0,
                active: it.active !== false,
              }
            }),
          })
        }
        return tpl
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product-template', resourceId: template.id,
        detail: `创建商品模板: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(template), { status: 201 })
    } catch (error) {
      console.error('[POST /api/product-templates]', error)
      return NextResponse.json({ error: '创建商品模板失败' }, { status: 500 })
    }
  }, { require: 'master.product_template.create' })
}
