import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { postStockMove, LOC, type StockMoveKind } from '@/lib/stock-ledger'

/**
 * GET /api/stock-moves —— 库存流水
 *   不带 paged：保持旧行为，返回数组（?productId=&limit=）
 *   paged=1（20261014 复式改造 L3「库存流水」页 / 单据上的流水区块）：
 *     ?sourceId=&sourceTypes=A,B&productId=&lotId=&location=&from=&to=&q=&page=&pageSize=
 *     返回 { items, total }，每笔带来源/去向库位名称
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const productId = searchParams.get('productId')
    if (searchParams.get('paged') !== '1') {
      const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') ?? '1000', 10)))
      const moves = await prisma.stockMove.findMany({
        where: productId ? { productId } : undefined,
        orderBy: { movedAt: 'desc' },
        take: limit,
        include: { lot: { select: { lotNumber: true, bestBefore: true } } },
      })
      return NextResponse.json(serializeApi(moves))
    }
    const where: Record<string, unknown> = {}
    const and: Record<string, unknown>[] = []
    if (productId) where.productId = productId
    const sourceId = searchParams.get('sourceId')
    if (sourceId) where.sourceId = sourceId
    const sourceTypes = (searchParams.get('sourceTypes') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (sourceTypes.length) where.sourceType = { in: sourceTypes }
    const lotId = searchParams.get('lotId')
    if (lotId) where.lotId = lotId
    const type = searchParams.get('type')
    if (type) where.type = type.toUpperCase()
    const location = searchParams.get('location')
    if (location) and.push({ OR: [{ fromLocationId: location }, { toLocationId: location }] })
    const from = searchParams.get('from'), to = searchParams.get('to')
    if (from || to) where.movedAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(new Date(to).getTime() + 86400000) } : {}) }
    const q = searchParams.get('q')?.trim()
    if (q) and.push({ OR: [{ productName: { contains: q, mode: 'insensitive' } }, { sourceRef: { contains: q, mode: 'insensitive' } }, { note: { contains: q, mode: 'insensitive' } }] })
    if (and.length) where.AND = and
    const pageSize = Math.min(500, Math.max(1, parseInt(searchParams.get('pageSize') ?? '80', 10)))
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const [items, total] = await Promise.all([
      prisma.stockMove.findMany({
        where,
        orderBy: [{ movedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lot: { select: { lotNumber: true, bestBefore: true } },
          fromLocation: { select: { code: true, nameZh: true } },
          toLocation: { select: { code: true, nameZh: true } },
        },
      }),
      prisma.stockMove.count({ where }),
    ])
    const uomIds = [...new Set(items.map(i => i.uomId).filter((v): v is string => !!v))]
    const uoms = uomIds.length ? await prisma.uom.findMany({ where: { id: { in: uomIds } }, select: { id: true, name: true } }) : []
    const uomName = new Map(uoms.map(u => [u.id, u.name]))
    return NextResponse.json(serializeApi({
      items: items.map(i => ({ ...i, uomName: i.uomId ? uomName.get(i.uomId) ?? null : null })),
      total,
    }))
  } catch (error) {
    console.error('[GET /api/stock-moves]', error)
    return NextResponse.json({ error: '获取库存记录失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // 服务端校验
      const productId = data.productId?.toString().trim()
      const productName = data.productName?.toString().trim().slice(0, 200)
      const qty = Number(data.qty)
      const note = data.note?.toString().trim().slice(0, 500) ?? ''

      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })
      if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 100000) {
        return NextResponse.json({ error: '数量不能为 0，且绝对值不超过 100,000' }, { status: 400 })
      }

      const sourceType = data.sourceType?.toString().trim().slice(0, 50) || null
      const sourceId = data.sourceId?.toString().trim() || null
      const sourceRef = data.sourceRef?.toString().trim().slice(0, 100) || null

      const movedAt = data.movedAt ? new Date(data.movedAt) : new Date()
      const lotId = data.lotId?.toString().trim() || null
      const moveType: string = data.type?.toString().toUpperCase() ?? 'ADJUSTMENT'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      // 校验商品存在（库存调整需更新其在手量）
      const product = await p.product.findUnique({ where: { id: productId }, select: { id: true, name: true } })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      // 出库/报废/负向调整时，如果指定了 lotId，扣减 Lot.currentQty
      const isConsumption = lotId && qty < 0
      if (isConsumption) {
        const lot = await p.lot.findUnique({ where: { id: lotId } })
        if (!lot) return NextResponse.json({ error: '批次不存在' }, { status: 404 })
        if (lot.productId !== productId) {
          return NextResponse.json({ error: '批次与商品不匹配' }, { status: 400 })
        }
        const absQty = Math.abs(qty)
        if (Number(lot.currentQty) < absQty) {
          return NextResponse.json({ error: `批次剩余库存不足（剩余 ${lot.currentQty}）` }, { status: 400 })
        }
      }

      // 入账（lib/stock-ledger.ts，20261014 复式改造 L3）：手工调整一律走「盘点调整」虚拟库位，
      // 报废走「报废」、退货走「客户」。指定批次则只动那一批；未指定批次的出库按 FEFO 扣批次
      // （以前不扣批次，Lot.currentQty 与 qtyOnHand 会分叉）。
      const counter = moveType === 'SCRAP' ? LOC.SCRAP : moveType === 'RETURN' ? LOC.CUSTOMERS : LOC.INVENTORY
      const kind = (['IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'SCRAP'].includes(moveType) ? moveType : 'ADJUSTMENT') as StockMoveKind
      const move = await p.$transaction(async (tx: typeof p) => {
        const moves = await postStockMove(tx, {
          productId,
          productName: productName || product.name || '未知商品',
          qty: Math.abs(qty),
          from: qty > 0 ? counter : LOC.STOCK,
          to: qty > 0 ? LOC.STOCK : counter,
          type: kind,
          lot: lotId ? { mode: 'lot', lotId, adjustLot: true } : qty < 0 ? { mode: 'fefo' } : { mode: 'none' },
          note,
          movedAt,
          sourceType: sourceType ?? 'MANUAL',
          sourceId,
          sourceRef,
          userId: user.userId,
          createdBy: user.name ?? user.email,
        })
        if (moves.length === 0) throw Object.assign(new Error('只有实物商品可以调整库存'), { status: 400 })
        return tx.stockMove.findUnique({ where: { id: moves[0].id } })
      })

      // resource 用 'product'+商品id，和商品详情页 ChatterFeed 的查询条件对齐，
      // 否则手动调整库存会写进 ActionLog 但商品详情页的"操作日志"永远查不到（20260823 修；
      // 20260825 合表重构后 resource 从 'product-template' 统一改成 'product'）。
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product', resourceId: product.id,
        detail: `库存调整: ${qty > 0 ? '+' : ''}${qty}${note ? `（${note}）` : ''}` })
      return NextResponse.json(serializeApi(move), { status: 201 })
    } catch (error) {
      const st = (error as { status?: number })?.status
      if (st && st >= 400 && st < 500) return NextResponse.json({ error: (error as Error).message }, { status: st })
      console.error('[POST /api/stock-moves]', error)
      return NextResponse.json({ error: '创建库存记录失败' }, { status: 500 })
    }
  }, { require: 'stock.move.create' })
}
