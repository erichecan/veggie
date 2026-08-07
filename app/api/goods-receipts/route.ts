import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { toNum } from '@/lib/decimal-helpers'
import { SCRAP_REASON_LABEL } from '@/lib/scrap-reasons'

/**
 * /api/goods-receipts
 * ============================================================================
 * 收货单（对应 Odoo stock.picking type=incoming）—— 库存管理「收货」工作台的落地接口
 *
 * POST body:
 *   { purchaseOrderId, arrivedAt, notes?, photos?: string[],
 *     lines: [{productId, qty, uomId?, condition:'ok'|'damaged', bestBefore?}] }
 *   同一 productId 可以拆成两条（一条 ok、一条 damaged），表达"这行有部分损坏"。
 *
 * 业务：
 *   1) 校验 PO 存在且状态 ∈ {CONFIRMED, RECEIVED}（允许分批到货）
 *   2) 生成 GR 编号
 *   3) 事务内：
 *      - 创建 GoodsReceipt（含取证照片）
 *      - 更新 PO 各 Line 的 receivedQty（良品+损坏都计入，视为供应商已交付；见 2026-07-10 决策）
 *      - 良品：给 Product.qtyOnHand 加上收到的数量，写 StockMove(type=IN)，建 Lot（保质期按本次收货行填写，不再死绑
 *        PO 行下单时的计划值）
 *      - 损坏：不进库存、不建 Lot，改写一笔 StockMove(type=SCRAP, sourceType=RECEIPT_DAMAGE, lotId=null) 留痕，
 *        自然落入损耗仪表盘的 SCRAP 统计，方便追损耗/找供应商索赔
 *      - 如果所有 line 的 receivedQty >= orderedQty，把 PO 状态改为 RECEIVED
 */

interface InLine {
  productId: string
  productName?: string
  qty: number
  uomId?: string
  condition?: 'ok' | 'damaged'
  /** 本次收货实际看到的保质期，覆盖 PO 行下单时填的计划值；不传则回退用 PO 行原值 */
  bestBefore?: string | null
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '100', 10)))
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))
    const search = searchParams.get('search')?.trim() ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const where = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { purchaseOrder: { name: { contains: search, mode: 'insensitive' } } }] }
      : {}
    // ?id=xxx → 单条，带上照片。列表页展开某一条时才调，见下面为什么。
    const singleId = searchParams.get('id')?.trim()
    if (singleId) {
      const one = await p.goodsReceipt.findUnique({
        where: { id: singleId },
        include: { purchaseOrder: { select: { id: true, name: true, supplierId: true } } },
      })
      if (!one) return NextResponse.json({ error: '收货单不存在' }, { status: 404 })
      return NextResponse.json(serializeApi(one))
    }

    // ⛔ 列表**不返回 photos**，只给数量。
    // photos 是 String[]，里面存的是 base64 data URI（取证照片，单张上限 5 MB）。
    // 实测：23 条收货单 6.06 MB，其中 photos 占 6.02 MB —— 99%。
    // 而列表默认是折叠的，照片只有展开某一条时才显示。为了那一条把另外 22 条的
    // 照片也传过来，是纯粹的浪费。展开时用 ?id= 单独取。
    // ⛔ 必须用 select 显式列字段，不能 findMany 出来再在 JS 里把 photos 删掉。
    // 那样只省了「Node→浏览器」这一段，「DB→Node」照样传 6 MB —— 实测响应体积从
    // 6.06 MB 降到 14 KB 而耗时仍是 1.18 s，就是这么来的。Prisma 没有"排除某字段"，
    // 只能把要的都列出来。新增字段时记得同步这里。
    const [total, rows] = await Promise.all([
      p.goodsReceipt.count({ where }),
      p.goodsReceipt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true, name: true, purchaseOrderId: true, arrivedAt: true,
          receivedBy: true, lines: true, notes: true, createdAt: true,
          purchaseOrder: { select: { id: true, name: true, supplierId: true } },
        },
      }),
    ])
    // 照片数量单独查：只取 id + photos 会把 6 MB 又读回来，所以用 SQL 只算长度。
    const counts = await prisma.$queryRaw<{ id: string; n: bigint }[]>`
      SELECT id, coalesce(array_length(photos, 1), 0)::bigint AS n
      FROM "GoodsReceipt"
      WHERE id = ANY(${rows.map((r: { id: string }) => r.id)})
    `
    const countMap = new Map(counts.map((c) => [c.id, Number(c.n)]))
    const items = rows.map((r: { id: string }) => ({ ...r, photoCount: countMap.get(r.id) ?? 0 }))
    return NextResponse.json(serializeApi({ items, total }))
  } catch (error) {
    console.error('[GET /api/goods-receipts]', error)
    return NextResponse.json({ error: '获取收货单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const poId = String(data.purchaseOrderId ?? '').trim()
      if (!poId) return NextResponse.json({ error: 'purchaseOrderId 必填' }, { status: 400 })
      const lines: InLine[] = Array.isArray(data.lines) ? data.lines : []
      if (lines.length === 0) return NextResponse.json({ error: '收货行不能为空' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })
      if (!['CONFIRMED', 'RECEIVED'].includes(po.status)) {
        return NextResponse.json({
          error: `PO 状态 ${po.status}，无法收货（应为 CONFIRMED 或 RECEIVED）`,
        }, { status: 409 })
      }

      const grCount = await p.goodsReceipt.count()
      const grName = `GR-${String(grCount + 1).padStart(5, '0')}`

      // 库存批次日期：优先用 PO 的预期到货日（expectedDate），其次用 GR 实际到货日（arrivedAt）
      const grArrivedAt = data.arrivedAt ? new Date(data.arrivedAt) : new Date()
      const batchDate: Date = po.expectedDate ?? grArrivedAt
      const photos: string[] = Array.isArray(data.photos) ? data.photos.filter((x: unknown) => typeof x === 'string') : []

      const result = await p.$transaction(async (tx: typeof p) => {
        const gr = await tx.goodsReceipt.create({
          data: {
            name: grName,
            purchaseOrderId: poId,
            arrivedAt: grArrivedAt,
            receivedBy: user.name,
            lines: lines.map((l) => ({
              productId: l.productId,
              productName: l.productName ?? '',
              qty: Number(l.qty),
              uomId: l.uomId ?? null,
              condition: l.condition ?? 'ok',
              bestBefore: l.bestBefore ?? null,
            })),
            notes: data.notes ?? null,
            photos,
          },
        })

        // 批次编号计数器
        let lotSeq = await tx.lot.count()

        // 更新每条 PO line 的 receivedQty + Lot + StockMove + Product.qtyOnHand
        for (const l of lines) {
          const poLine = po.lines.find((pl: { productId: string; bestBefore?: Date | null; unitCost?: unknown }) => pl.productId === l.productId)
          if (!poLine) continue
          const qty = Number(l.qty)
          if (qty <= 0) continue
          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: { receivedQty: { increment: qty } },
          })
          // damaged 的货不入库
          if ((l.condition ?? 'ok') === 'ok') {
            // SSOT(成本): 收货按加权平均回写 standardPrice(此前收货从不回写,成本陈旧 — P2)
            // newStd = (max(oldQty,0)×oldStd + qty×收货价) / (max(oldQty,0)+qty);负库存按 0 计权
            // 用折合欧元的单价(unitCostEur)，不能直接拿 PO 原币 unitCost 当欧元——非欧元采购单
            // 必须先按 PO.exchangeRate 折算过才能进公司统一记的欧元成本基准(20260713 汇率换算改造)。
            // unitCostEur 为空(理论上不会,CONFIRM 阶段已挡住汇率待确认的单)时按 0 处理，与原逻辑一致跳过更新。
            const recvCost = Number((poLine as { unitCostEur?: unknown; unitCost?: unknown }).unitCostEur ?? 0)
            const prod = await tx.product.findUnique({ where: { id: l.productId }, select: { qtyOnHand: true, standardPrice: true } })
            const oldQty = Math.max(Number(prod?.qtyOnHand ?? 0), 0)
            const oldStd = Number(prod?.standardPrice ?? 0)
            const newStd = recvCost > 0 && (oldQty + qty) > 0
              ? Math.round(((oldQty * oldStd + qty * recvCost) / (oldQty + qty)) * 100) / 100
              : oldStd
            await tx.product.update({
              where: { id: l.productId },
              data: { qtyOnHand: { increment: qty }, ...(newStd !== oldStd ? { standardPrice: newStd } : {}) },
            })

            // 创建批次；保质期优先用本次收货行实际填写的值（实物到货才知道真实保质期），
            // 不传则回退用 PO 行下单时的计划值
            lotSeq++
            const lotNumber = `LOT-${String(lotSeq).padStart(5, '0')}`
            const lineBestBefore = l.bestBefore ? new Date(l.bestBefore) : (poLine.bestBefore ?? null)
            const lot = await tx.lot.create({
              data: {
                lotNumber,
                productId: l.productId,
                initialQty: qty,
                currentQty: qty,
                sourceType: 'GOODS_RECEIPT',
                sourceId: gr.id,
                sourceRef: grName,
                bestBefore: lineBestBefore,
                arrivedAt: batchDate,
                // SSOT(成本): 批次成本 = PO 行真实采购价，毛利/损耗分析按批次计成本
                unitCost: recvCost > 0 ? recvCost : null,
              },
            })

            await tx.stockMove.create({
              data: {
                productId: l.productId,
                productName: l.productName ?? poLine.productName,
                type: 'IN',
                qty,
                lotId: lot.id,
                movedAt: batchDate,
                note: `收货 ${grName} / PO ${po.name} / 批次 ${lotNumber}`,
                sourceType: 'GOODS_RECEIPT',
                sourceId: gr.id,
                sourceRef: grName,
              },
            })
          } else {
            // 损坏：不进库存、不建 Lot，但算供应商已交付（上面 receivedQty 已计入）。
            // 写一笔无批次归属的 SCRAP StockMove 留痕，自然落入损耗仪表盘统计，方便追损耗/找供应商索赔。
            await tx.stockMove.create({
              data: {
                productId: l.productId,
                productName: l.productName ?? poLine.productName,
                type: 'SCRAP',
                qty,
                lotId: null,
                movedAt: batchDate,
                note: `${SCRAP_REASON_LABEL.RECEIPT_DAMAGE} - 收货 ${grName} / PO ${po.name}`,
                sourceType: 'RECEIPT_DAMAGE',
                sourceId: gr.id,
                sourceRef: grName,
              },
            })
          }
        }

        // 检查是否全量到货
        const updatedPo = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          include: { lines: true },
        })
        const allReceived = updatedPo.lines.every(
          (l: { receivedQty: unknown; orderedQty: unknown }) =>
            toNum(l.receivedQty) >= toNum(l.orderedQty),
        )
        if (allReceived && po.status !== 'RECEIVED') {
          await tx.purchaseOrder.update({
            where: { id: poId },
            data: { status: 'RECEIVED' },
          })
        }

        return gr
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'goods_receipt', resourceId: result.id,
        detail: `${grName} 收货，PO=${po.name}`,
      })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      console.error('[POST /api/goods-receipts]', error)
      return NextResponse.json({ error: '收货失败' }, { status: 500 })
    }
  }, { require: 'stock.receipt.create' })
}
