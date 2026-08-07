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
          internalRef: data.internalRef !== undefined ? String(data.internalRef).trim().slice(0, 100) : undefined,
          status: data.status?.toUpperCase() ?? undefined,
          variantAttributes: data.variantAttributes ?? undefined,
          images: data.images ?? undefined,
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
  }, ['OPERATOR', 'BOSS'])
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.product.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'product', resourceId: id,
        detail: `删除商品: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/products/[id]]', error)
      return NextResponse.json({ error: '删除商品失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}
