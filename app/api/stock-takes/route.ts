import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

/**
 * /api/stock-takes
 * ============================================================================
 * 库存盘点单。
 *
 * GET  ?status=&limit=&offset=  列表
 * POST { takenAt, categoryIds?: string[], productIds?: string[], notes? }
 *      建单：对选中商品快照 qtyOnHand 为 systemQty。
 *      categoryIds / productIds 至少给一个（全仓盘点传 categoryIds=[] 显式不允许，
 *      避免误建 1700+ 行的大单；全仓分多次按分类盘）。
 */

const STOCK_TAKE_ROLES = ['OPERATOR', 'WAREHOUSE', 'BOSS']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const status = searchParams.get('status')
      const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)))
      const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const where = status ? { status } : {}
      const [total, items] = await Promise.all([
        p.stockTake.count({ where }),
        p.stockTake.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          include: { _count: { select: { lines: true } } },
        }),
      ])
      return NextResponse.json(serializeApi({ items, total }))
    } catch (error) {
      console.error('[GET /api/stock-takes]', error)
      return NextResponse.json({ error: '获取盘点单失败' }, { status: 500 })
    }
  }, { require: 'stock.take.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const categoryIds: string[] = Array.isArray(data.categoryIds) ? data.categoryIds.filter(Boolean) : []
      const productIds: string[] = Array.isArray(data.productIds) ? data.productIds.filter(Boolean) : []
      if (categoryIds.length === 0 && productIds.length === 0) {
        return NextResponse.json({ error: '请选择盘点范围（分类或商品）' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const products = await p.product.findMany({
        where: {
          active: true,
          status: 'ACTIVE',
          OR: [
            ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
            ...(productIds.length > 0 ? [{ id: { in: productIds } }] : []),
          ],
        },
        select: { id: true, name: true, spec: true, qtyOnHand: true },
        orderBy: { name: 'asc' },
      })
      if (products.length === 0) {
        return NextResponse.json({ error: '所选范围内没有可盘点的商品' }, { status: 400 })
      }
      if (products.length > 500) {
        return NextResponse.json({ error: `范围过大（${products.length} 个商品），单张盘点单上限 500，请按分类拆分` }, { status: 400 })
      }

      const count = await p.stockTake.count()
      const name = `STK-${String(count + 1).padStart(5, '0')}`
      const takenAt = data.takenAt ? new Date(data.takenAt) : new Date()

      const created = await p.stockTake.create({
        data: {
          name,
          takenAt,
          createdBy: user.name,
          notes: data.notes ?? null,
          lines: {
            create: products.map((prod: { id: string; name: string; spec: string | null; qtyOnHand: unknown }) => ({
              productId: prod.id,
              productName: prod.spec ? `${prod.name} (${prod.spec})` : prod.name,
              systemQty: prod.qtyOnHand,
            })),
          },
        },
        include: { lines: true },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'stock_take', resourceId: created.id,
        detail: `${name} 建盘点单，${products.length} 个商品`,
      })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      console.error('[POST /api/stock-takes]', error)
      return NextResponse.json({ error: '创建盘点单失败' }, { status: 500 })
    }
  }, { require: 'stock.take.create' })
}
