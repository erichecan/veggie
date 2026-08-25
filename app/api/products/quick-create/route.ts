import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * POST /api/products/quick-create — 采购下单时"选不到商品，当场建一个"的快速建档入口。
 * 默认 canBeSold=false / canBePurchased=true：只是先能被采购选中，销售上架前还要去商品库补全销售价/税率/图片。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const name = String(data.name ?? '').trim()
      if (!name) return NextResponse.json({ error: '商品名称不能为空' }, { status: 400 })

      const categoryId = data.categoryId ? String(data.categoryId) : null
      const purchaseUomId = data.purchaseUomId ? String(data.purchaseUomId) : null
      const unitCost = data.unitCost !== undefined && data.unitCost !== null && data.unitCost !== ''
        ? Number(data.unitCost)
        : null

      const product = await prisma.product.create({
        data: {
          name,
          categoryId,
          purchaseUomId,
          standardPrice: unitCost,
          canBeSold: false,
          canBePurchased: true,
          status: 'ACTIVE',
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product', resourceId: product.id,
        detail: `采购下单时快速建档: ${name}`,
      })
      return NextResponse.json(serializeApi(product), { status: 201 })
    } catch (error) {
      console.error('[POST /api/products/quick-create]', error)
      return NextResponse.json({ error: '创建商品失败' }, { status: 500 })
    }
  }, { require: 'master.product.create' })
}
