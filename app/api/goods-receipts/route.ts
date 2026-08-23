import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { notifyRole } from '@/lib/notify'
import {
  parseQc, validateQcLines, lineVerdict, formatQcSummary,
  isQcRejectReason, QcInputError, QC_REJECT_REASON_LABELS,
  type QcRecord, type QcRejectReason,
} from '@/lib/purchase/qc'

/**
 * /api/goods-receipts
 * ============================================================================
 * 收货单（对应 Odoo stock.picking type=incoming）—— 库存管理「收货」工作台的落地接口
 *
 * ⚠️ 20260823 起：本接口**只记录到货、不再改库存**。良品/次品数量、批次、验收备注
 * 照旧全部录入并落库（决策#1），但 Product.qtyOnHand / StockMove / Lot /
 * PurchaseOrderLine.receivedQty / PO 状态流转全部**不再由这里触发**——真正计入库存的
 * 动作搬到了采购单详情页的「确认收货」（`PATCH /api/purchase-orders/[id]` action=receive，
 * 见 lib/purchase/receive-purchase-order.ts）。这里退化成"物理确认的记录单"：仓库看到什么
 * 就填什么，供采购同事在确认收货时参考，两边职责不再纠缠。
 *
 * POST body:
 *   { purchaseOrderId, arrivedAt, notes?, photos?: string[],
 *     lines: [{productId, qty, uomId?, condition:'ok'|'damaged'|'rejected', bestBefore?,
 *              qc?: {weightKg?, freshness?, pesticide?, note?}, rejectReason?}] }
 *   同一 productId 可以拆成多条（ok / damaged / rejected），表达"这行部分损坏、部分退回"。
 *   三种 condition 纯粹是记录用的分类，本身不再触发任何库存动作。
 *
 * 业务：
 *   1) 校验 PO 存在且状态 ∈ {CONFIRMED, RECEIVED}（允许分批到货记录）
 *   2) 生成 GR 编号
 *   3) 事务内创建 GoodsReceipt（含取证照片与质检记录），并回写 PO 的
 *      firstArrivedAt/lastArrivedAt（台账 E7 准时率用，与库存无关，纯粹是"这批货几号到的"）
 *   4) 成功后通知采购角色（OPERATOR）：到货已记录，等待确认收货计入库存
 */

interface InLine {
  productId: string
  productName?: string
  qty: number
  uomId?: string
  condition?: 'ok' | 'damaged' | 'rejected'
  /** 本次收货实际看到的保质期，覆盖 PO 行下单时填的计划值；不传则回退用 PO 行原值 */
  bestBefore?: string | null
  /** 质检记录（可留空）：实测重量 / 新鲜度 / 农残 */
  qc?: unknown
  /** 拒收原因；condition='rejected' 时必填 */
  rejectReason?: QcRejectReason
}

/** 归一化后的收货行：质检已解析、condition 已收敛到三态 */
interface NormLine extends Omit<InLine, 'qc' | 'condition'> {
  condition: 'ok' | 'damaged' | 'rejected'
  qc: QcRecord | null
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
        include: { purchaseOrder: { select: { id: true, name: true, supplierId: true, expectedDate: true } } },
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
          // expectedDate：收货历史要能当场对出「预计 vs 实际」，否则准时率只能事后另查一遍（台账 E6）
          purchaseOrder: { select: { id: true, name: true, supplierId: true, expectedDate: true } },
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
      const rawLines: InLine[] = Array.isArray(data.lines) ? data.lines : []
      if (rawLines.length === 0) return NextResponse.json({ error: '收货行不能为空' }, { status: 400 })

      // 质检解析与校验（台账 F4）——**在事务之前**做完。
      // 非法枚举值直接 400 而不是静默丢弃：悄悄丢掉等于「界面上填了、库里没有」，
      // 而操作员看到的是提交成功。
      let lines: NormLine[]
      try {
        lines = rawLines.map((l) => ({
          ...l,
          condition: l.condition === 'damaged' ? 'damaged' : l.condition === 'rejected' ? 'rejected' : 'ok',
          qc: parseQc(l.qc),
          rejectReason: isQcRejectReason(l.rejectReason) ? l.rejectReason : undefined,
        }))
      } catch (e) {
        if (e instanceof QcInputError) return NextResponse.json({ error: e.message }, { status: 400 })
        throw e
      }
      const qcError = validateQcLines(lines)
      if (qcError) return NextResponse.json({ error: qcError }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })
      if (!['CONFIRMED', 'RECEIVED'].includes(po.status)) {
        return NextResponse.json({
          error: `PO 状态 ${po.status}，无法记录收货（应为 CONFIRMED 或 RECEIVED）`,
        }, { status: 409 })
      }

      const grCount = await p.goodsReceipt.count()
      const grName = `GR-${String(grCount + 1).padStart(5, '0')}`
      const grArrivedAt = data.arrivedAt ? new Date(data.arrivedAt) : new Date()
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
              condition: l.condition,
              bestBefore: l.bestBefore ?? null,
              // 质检记录随收货行一起落库（不另起表，见 lib/purchase/qc.ts 开头）。
              // checkedBy/checkedAt 服务端盖章，不接受客户端传值 —— 「谁签的字」不能由前端说了算。
              qc: l.qc ? { ...l.qc, checkedBy: user.name, checkedAt: grArrivedAt.toISOString() } : null,
              rejectReason: l.rejectReason ?? null,
            })),
            notes: data.notes ?? null,
            photos,
          },
        })

        // 实际到货日回写（台账 E7）：与库存无关，纯粹是"这批货几号到的"，供准时率统计。
        // ⚠️ 不能写成「first 为空就填、last 直接覆盖」——收货单允许补录，
        // 补一张日期更早的进来时，first 必须往前挪、last 不能被这张旧的顶掉。
        // 所以两个都按 min/max 取，与收货单的录入顺序无关。
        const arrivals = await tx.goodsReceipt.aggregate({
          where: { purchaseOrderId: poId },
          _min: { arrivedAt: true },
          _max: { arrivedAt: true },
        })
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            firstArrivedAt: arrivals._min.arrivedAt ?? grArrivedAt,
            lastArrivedAt: arrivals._max.arrivedAt ?? grArrivedAt,
          },
        })

        return gr
      })

      const rejected = lines.filter((l) => l.condition === 'rejected' && Number(l.qty) > 0)
      const damaged = lines.filter((l) => l.condition === 'damaged' && Number(l.qty) > 0)
      const qcChecked = lines.filter((l) => lineVerdict(l.qc, l.condition === 'rejected' ? Number(l.qty) : 0))
      const qcNote = qcChecked.length > 0 ? ` · 质检 ${qcChecked.length} 行` : ''
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'goods_receipt', resourceId: result.id,
        detail: `${grName} 记录到货，PO=${po.name}${qcNote}`,
      })
      // 拒收另记一条**挂在采购单上**的日志：收货单的日志采购员不会去翻，
      // 而"这批货被退回、还没收齐"正是他们必须知道的事（PO 详情的 chatter 读的就是这条）
      if (rejected.length > 0) {
        const detail = rejected.map((l) => {
          const reason = l.rejectReason ? QC_REJECT_REASON_LABELS[l.rejectReason].zh : '未注明'
          const summary = formatQcSummary(l.qc)
          return `${l.productName || l.productId} ×${Number(l.qty)}（${reason}${summary ? ` · ${summary}` : ''}）`
        }).join('；')
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'purchase_order', resourceId: poId,
          detail: `${grName} 质检拒收：${detail}。拒收部分供采购确认收货时参考，是否计入由采购决定`,
        })
      }

      // 到货已记录，通知采购角色去「确认收货」把它计入库存（决策#4：无独立采购角色，通知 OPERATOR）
      const summary = [
        damaged.length > 0 ? `${damaged.length} 项有损坏` : null,
        rejected.length > 0 ? `${rejected.length} 项拒收` : null,
      ].filter(Boolean).join('，')
      await notifyRole(['OPERATOR'], {
        type: 'goods_receipt',
        title: `到货记录：${grName}`,
        body: `采购单 ${po.name} 已记录到货（${lines.length} 行${summary ? `，${summary}` : ''}），请到采购单详情页确认收货以计入库存。`,
        data: { purchaseOrderId: poId, goodsReceiptId: result.id },
      })

      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      console.error('[POST /api/goods-receipts]', error)
      return NextResponse.json({ error: '记录收货失败' }, { status: 500 })
    }
  }, { require: 'stock.receipt.create' })
}
