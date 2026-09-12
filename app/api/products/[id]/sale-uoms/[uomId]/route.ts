import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { normalizeUomSequence, normalizeGrossWeight } from '@/lib/sale-uom'

/**
 * /api/products/[id]/sale-uoms/[uomId] — 单条可售单位行的局部修改（20260912）
 * ============================================================================
 * 只服务"按可售单位查看商品"页的行内编辑：那一页一行 = 一个可售单位，
 * 编辑一个单元格不该像商品详情页的弹窗那样要求整份 items 数组一起 PUT 回去。
 * 只认三个字段（spec/sequence/grossWeight）——价格/提成公式那几个字段涉及
 * priceMode 三态联动，不在这条轻量接口的范围内，仍然只能走 PUT 整份替换。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; uomId: string }> }) {
  const { id, uomId } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const data: Record<string, unknown> = {}
      if ('spec' in body) data.spec = typeof body.spec === 'string' && body.spec.trim() ? body.spec.trim() : null
      if ('sequence' in body) data.sequence = normalizeUomSequence(body.sequence)
      if ('grossWeight' in body) data.grossWeight = normalizeGrossWeight(body.grossWeight)
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
      }
      data.updatedBy = user.name || user.email

      const row = await prisma.productSaleUom.update({
        where: { productId_uomId: { productId: id, uomId } },
        data,
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product_sale_uom', resourceId: id,
        detail: `按可售单位查看商品：更新单位 ${uomId} 的 ${Object.keys(data).filter(k => k !== 'updatedBy').join('/')}`,
      })

      return NextResponse.json(serializeApi(row))
    } catch (error) {
      console.error('[PATCH /api/products/[id]/sale-uoms/[uomId]]', error)
      return NextResponse.json({ error: '更新失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
