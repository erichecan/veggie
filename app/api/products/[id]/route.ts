import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

const PRODUCT_TRACKED_FIELDS = [
  'name', 'internalRef', 'listPrice', 'standardPrice', 'qtyOnHand',
  'active', 'categoryId', 'customerTaxRate', 'commissionPrice', 'status',
  'variantAttributes', 'images',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const product = await prisma.product.findUnique({ where: { id } })
    if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(product))
  } catch (error) {
    console.error('[GET /api/products/[id]]', error)
    return NextResponse.json({ error: '获取商品失败' }, { status: 500 })
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

      const before = await prisma.product.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '商品不存在' }, { status: 404 })
      const product = await prisma.product.update({
        where: { id },
        data: {
          ...data,
          name: data.name !== undefined ? String(data.name).trim().slice(0, 200) : undefined,
          // data.internalRef 是 null(字段本来是空的，前端整对象回传)时不能走 String(null)，
          // 那会把字面字符串 "null" 写进数据库——见 product-templates/[id]/route.ts 同款修复。
          internalRef: data.internalRef === undefined ? undefined : (data.internalRef == null || String(data.internalRef).trim() === '' ? null : String(data.internalRef).trim().slice(0, 100)),
          status: data.status?.toUpperCase() ?? undefined,
          // ⛔ 20260825 合表重构遗留 bug：商品详情页把 tmpl.type 标准化成小写显示('product'/'consu'/'service')，
          // 保存时整对象回传，这里原来没跟 status 一样转大写 —— Prisma 枚举校验直接 500，
          // 商品详情页整页保存(Edit→Save)必现失败(实测复现)。
          type: data.type !== undefined ? String(data.type).toUpperCase() : undefined,
          variantAttributes: data.variantAttributes ?? undefined,
          images: data.images ?? undefined,
          // 只是导入时的一次性快照，此前编辑商品从不回写，"最后更新人"永远停在
          // Odoo 导入那一刻的值——哪怕 updatedAt 已经变了。以当前登录用户为准，
          // 不接受客户端传入（...data 展开在前，这里覆盖，越权改不了别人名字）。
          updatedBy: user.name || user.email,
        },
      })
      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        product as unknown as Record<string, unknown>,
        PRODUCT_TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product', resourceId: id,
        detail: `更新商品: ${data.name || id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(product))
    } catch (error) {
      console.error('[PUT /api/products/[id]]', error)
      return NextResponse.json({ error: '更新商品失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const product = await prisma.product.findUnique({ where: { id }, select: { id: true, name: true } })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      // 删除前必须核实这个商品「没在销售和购进用过」（客户 20260904 要求：复制出来的商品，
      // 若没在销售和购进用过，就可以真删除；用过的只能归档）。不能指望数据库外键来兜底——
      // 这些表里只有 OrderLine 声明了到 Product 的 relation 且没设 onDelete（默认 RESTRICT），
      // 其余全是裸 productId 字段、DB 层毫无约束，直接删商品会留下一堆指向不存在 id 的悬空
      // 记录；Lot 更麻烦，schema 里对它设的是 onDelete: Cascade，不先查它就直接删的话，会把
      // 这个商品的库存批次历史一并静默清空。
      const [
        orderLineCount, poLineCount, stockMoveCount, lotCount,
        creditNoteLineCount, stockTakeLineCount, discrepancyCount,
        purchaseRecordCount, purchaseSuggestionCount, specialPriceCount,
      ] = await Promise.all([
        prisma.orderLine.count({ where: { productId: id } }),
        prisma.purchaseOrderLine.count({ where: { productId: id } }),
        prisma.stockMove.count({ where: { productId: id } }),
        prisma.lot.count({ where: { productId: id } }),
        prisma.creditNoteLine.count({ where: { productId: id } }),
        prisma.stockTakeLine.count({ where: { productId: id } }),
        prisma.orderDiscrepancy.count({ where: { productId: id } }),
        prisma.purchaseRecord.count({ where: { productId: id } }),
        prisma.purchaseSuggestion.count({ where: { productId: id } }),
        prisma.customerSpecialPrice.count({ where: { productId: id } }),
      ])
      const reasons: string[] = []
      if (orderLineCount > 0) reasons.push(`${orderLineCount} 条销售/报价单行`)
      if (poLineCount > 0) reasons.push(`${poLineCount} 条采购单行`)
      if (stockMoveCount > 0) reasons.push(`${stockMoveCount} 条库存流水`)
      if (lotCount > 0) reasons.push(`${lotCount} 个批次记录`)
      if (creditNoteLineCount > 0) reasons.push(`${creditNoteLineCount} 条贷记单行`)
      if (stockTakeLineCount > 0) reasons.push(`${stockTakeLineCount} 条盘点行`)
      if (discrepancyCount > 0) reasons.push(`${discrepancyCount} 条拣货差异记录`)
      if (purchaseRecordCount > 0) reasons.push(`${purchaseRecordCount} 条历史采购记录`)
      if (purchaseSuggestionCount > 0) reasons.push(`${purchaseSuggestionCount} 条采购建议`)
      if (specialPriceCount > 0) reasons.push(`${specialPriceCount} 条客户专属价`)
      if (reasons.length > 0) {
        return NextResponse.json(
          { error: `商品「${product.name}」已被使用（${reasons.join('、')}），不可删除，请改为归档` },
          { status: 409 },
        )
      }

      await prisma.product.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'product', resourceId: id,
        detail: `删除商品: ${product.name}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/products/[id]]', error)
      return NextResponse.json({ error: '删除商品失败' }, { status: 500 })
    }
  }, { require: 'master.product.delete' })
}
