import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { saveAlias } from '@/lib/purchase/product-alias'

/**
 * POST /api/purchase-orders/product-aliases
 * ============================================================================
 * 采购单据核对界面里，操作员手动选中/改选商品即触发一次保存 —— 把单据原文
 * （含匹配不上的外语写法）记住指向哪个系统商品，下次同样写法出现在
 * `/api/purchase-orders/parse` 里会直接精确命中。全局生效，不分供应商。
 */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const rawName = String(data.rawName ?? '').trim()
      const productId = String(data.productId ?? '').trim()
      if (!rawName || !productId) {
        return NextResponse.json({ error: 'rawName 和 productId 均不能为空' }, { status: 400 })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, template: { select: { canBePurchased: true } } },
      })
      if (!product || !product.template.canBePurchased) {
        return NextResponse.json({ error: '商品不存在或不可采购' }, { status: 400 })
      }

      await saveAlias(rawName, productId)
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[POST /api/purchase-orders/product-aliases]', error)
      return NextResponse.json({ error: '保存对照关系失败' }, { status: 500 })
    }
  }, { require: 'purchase.order.create' })
}
