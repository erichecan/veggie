import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET() {
  try {
    const purchases = await prisma.purchaseRecord.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json(serializeApi(purchases))
  } catch (error) {
    console.error('[GET /api/purchases]', error)
    return NextResponse.json({ error: '获取采购记录失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // 服务端校验
      const productId = data.productId?.toString().trim()
      const productName = data.productName?.toString().trim().slice(0, 200)
      const supplier = data.supplier?.toString().trim().slice(0, 200)
      const quantity = Number(data.quantity)
      const unitCost = Number(data.unitCost)

      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
        return NextResponse.json({ error: '入库数量必须在 1–100,000 之间' }, { status: 400 })
      }
      if (!Number.isFinite(unitCost) || unitCost <= 0 || unitCost > 1000000) {
        return NextResponse.json({ error: '单价必须大于 0' }, { status: 400 })
      }
      if (!supplier) return NextResponse.json({ error: '供应商不能为空' }, { status: 400 })

      const purchase = await prisma.purchaseRecord.create({
        data: {
          productId,
          productName: productName || '未知商品',
          spec: data.spec?.toString().trim().slice(0, 100) ?? '',
          quantity,
          unitCost,
          supplier,
          arrivedAt: data.arrivedAt ?? new Date().toISOString(),
        },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase', resourceId: purchase.id,
        detail: `创建采购记录: ${purchase.id}` })
      return NextResponse.json(serializeApi(purchase), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchases]', error)
      return NextResponse.json({ error: '创建采购记录失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
