import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

// 字段级 diff 跟踪的字段集合（必须出现在 ProductTemplate 上）
const TRACKED_FIELDS = [
  'internalRef', 'sequence', 'name', 'saleDescription',
  'listPrice', 'customerTaxRate', 'standardPrice', 'vendorTaxRate',
  'weight', 'grossWeight', 'netWeight', 'categoryId', 'type', 'commissionPrice',
  'status', 'canBeSold', 'description',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const template = await prisma.productTemplate.findUnique({ where: { id } })
    if (!template) return NextResponse.json({ error: '商品模板不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(template))
  } catch (error) {
    console.error('[GET /api/product-templates/[id]]', error)
    return NextResponse.json({ error: '获取商品模板失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // 服务端校验数值字段
      if (data.listPrice !== undefined) {
        const listPrice = Number(data.listPrice)
        if (!Number.isFinite(listPrice) || listPrice < 0 || listPrice > 1000000) {
          return NextResponse.json({ error: '销售价必须在 0–1,000,000 之间' }, { status: 400 })
        }
      }
      if (data.standardPrice !== undefined) {
        const standardPrice = Number(data.standardPrice)
        if (!Number.isFinite(standardPrice) || standardPrice < 0 || standardPrice > 1000000) {
          return NextResponse.json({ error: '成本价必须在 0–1,000,000 之间' }, { status: 400 })
        }
      }
      if (data.customerTaxRate !== undefined) {
        const taxRate = Number(data.customerTaxRate)
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
          return NextResponse.json({ error: '税率必须在 0–1 之间' }, { status: 400 })
        }
      }

      // 先读旧值，方便后面做字段级 diff
      const before = await prisma.productTemplate.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '商品模板不存在' }, { status: 404 })

      const template = await prisma.productTemplate.update({
        where: { id },
        data: {
          ...data,
          name: data.name !== undefined ? String(data.name).trim().slice(0, 200) : undefined,
          // data.internalRef/description 是 null(字段本来是空的，前端整对象回传)时不能走
          // String(null)，那会把字面字符串 "null" 写进数据库——用 == null 把 null 和空字符串
          // 一起清成 Prisma null，undefined 才是"没传，不动这个字段"。
          internalRef: data.internalRef === undefined ? undefined : (data.internalRef == null || String(data.internalRef).trim() === '' ? null : String(data.internalRef).trim().slice(0, 100)),
          description: data.description === undefined ? undefined : (data.description == null || String(data.description).trim() === '' ? null : String(data.description).trim().slice(0, 2000)),
          type: data.type?.toUpperCase() ?? undefined,
          status: data.status?.toUpperCase() ?? undefined,
        },
      })
      // SSOT(定价): 定价引擎读 Product.listPrice(product-first),UI 只编辑模板 →
      // 必须把模板的价格字段传播到其所有变体,否则改价被静默忽略(P2 定价)。
      const priceProp: Record<string, unknown> = {}
      if (data.listPrice !== undefined) priceProp.listPrice = Number(data.listPrice)
      if (data.standardPrice !== undefined) priceProp.standardPrice = Number(data.standardPrice)
      if (data.customerTaxRate !== undefined) priceProp.customerTaxRate = Number(data.customerTaxRate)
      if (data.commissionPrice !== undefined) priceProp.commissionPrice = data.commissionPrice === null ? null : Number(data.commissionPrice)
      if (Object.keys(priceProp).length > 0) {
        await prisma.product.updateMany({ where: { templateId: id }, data: priceProp })
      }

      const isArchive = data.status?.toUpperCase() === 'ARCHIVED'
      const isRestore = data.status?.toUpperCase() === 'ACTIVE'
      const logDetail = isArchive
        ? `归档商品: ${template.name}`
        : isRestore
          ? `恢复上架商品: ${template.name}`
          : `更新商品模板: ${data.name || template.name}`

      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        template as unknown as Record<string, unknown>,
        TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product-template', resourceId: id,
        detail: logDetail,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(template))
    } catch (error) {
      console.error('[PUT /api/product-templates/[id]]', error)
      return NextResponse.json({ error: '更新商品模板失败' }, { status: 500 })
    }
  }, { require: 'master.product_template.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.productTemplate.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'product-template', resourceId: id,
        detail: `删除商品模板: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/product-templates/[id]]', error)
      return NextResponse.json({ error: '删除商品模板失败' }, { status: 500 })
    }
  }, { require: 'master.product_template.delete' })
}
