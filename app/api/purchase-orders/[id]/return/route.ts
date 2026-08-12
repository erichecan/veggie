/**
 * POST /api/purchase-orders/:id/return —— 采购退货（退给供应商）
 * ============================================================================
 * 台账 F3 验收里点名的一环：「退货能正确冲减库存」。此前**这条路根本不存在** ——
 * 收货只进不出，货收错了/坏了只能靠「报废」记一笔损耗，可那是自家损失，
 * 与「退回给供应商、应付款要跟着减」完全是两回事。
 *
 * 做最小闭环，不新建单据表：
 *   1. 校验退货量 ≤ 该行已收量（不能退比收到的还多）
 *   2. 扣减 Product.qtyOnHand + 记一笔 OUT 流水（负数），FIFO 回退批次余量
 *   3. 回冲 PurchaseOrderLine.receivedQty —— 这样「已收 / 应付」两边才对得上，
 *      也让采购建议的在途计算不会把退掉的货算成还在路上
 *
 * ⛔ 不动供应商账单金额：账单是财务凭证，退货后的抵扣该由财务开负数账单/贷记单处理，
 *    在这里偷偷改金额会让已过账的凭证与账面对不上。返回结果里给出应退金额供财务参考。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { consumeLotsFIFO, toStockQty } from '@/lib/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 退货只在「已收过货」的阶段有意义 */
const RETURNABLE_STATUSES = ['RECEIVED', 'INVOICED', 'CONFIRMED']

interface ReturnLineInput {
  productId?: unknown
  qty?: unknown
  reason?: unknown
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json() as { lines?: unknown; reason?: unknown }
      const rawLines = Array.isArray(body.lines) ? (body.lines as ReturnLineInput[]) : []
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''

      if (rawLines.length === 0) {
        return NextResponse.json({ error: '请至少选择一行退货商品' }, { status: 400 })
      }

      const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { lines: true },
      })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })
      if (po.status === 'LOCKED') {
        return NextResponse.json({ error: '已锁定的采购单不可退货' }, { status: 409 })
      }
      if (!RETURNABLE_STATUSES.includes(po.status)) {
        return NextResponse.json(
          { error: `采购单状态 ${po.status} 不能退货（需已收货）` },
          { status: 409 },
        )
      }

      // 先全量校验再落库：一行不合法就整单拒绝，不做「前两行成功第三行失败」的半吊子结果
      const planned: Array<{ lineId: string; productId: string; productName: string; qty: number; uomId: string | null; unitCost: number }> = []
      for (const raw of rawLines) {
        const productId = String(raw.productId ?? '')
        const qty = Number(raw.qty)
        const poLine = po.lines.find(l => l.productId === productId)
        if (!poLine) {
          return NextResponse.json({ error: `采购单里没有这个商品：${productId}` }, { status: 400 })
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          return NextResponse.json({ error: `退货数量无效：${raw.qty}` }, { status: 400 })
        }
        const received = toNum(poLine.receivedQty)
        if (qty > received) {
          return NextResponse.json(
            { error: `退货数量 ${qty} 超过已收数量 ${received}（${poLine.productName}）` },
            { status: 409 },
          )
        }
        planned.push({
          lineId: poLine.id,
          productId,
          productName: poLine.productName,
          qty,
          uomId: poLine.uomId ?? null,
          unitCost: toNum(poLine.unitCostEur ?? poLine.unitCost),
        })
      }

      const refundExTax = Math.round(planned.reduce((s, p) => s + p.qty * p.unitCost, 0) * 100) / 100
      const noteSuffix = reason ? ` - ${reason}` : ''

      const moves = await prisma.$transaction(async (tx) => {
        const created: Array<{ productId: string; stockQty: number }> = []
        for (const p of planned) {
          // 退货量按采购单位记，库存按基准单位记 —— 与收货侧同一套换算（I3 修过的那个坑）
          const stockQty = await toStockQty(tx as never, p.productId, p.qty, p.uomId)

          await tx.product.update({
            where: { id: p.productId },
            data: { qtyOnHand: { decrement: stockQty } },
          })
          // 批次也要退：只扣 qtyOnHand 不动批次，Lot.currentQty 会系统性虚高（db:validate 第 2 项）
          await consumeLotsFIFO(tx as never, p.productId, stockQty)

          await tx.stockMove.create({
            data: {
              productId: p.productId,
              productName: p.productName,
              type: 'OUT',
              qty: -stockQty,
              movedAt: new Date(),
              note: `采购退货 PO ${po.name}${noteSuffix}`,
              sourceType: 'PURCHASE_RETURN',
              sourceId: id,
              sourceRef: po.name,
            },
          })

          // 回冲已收量：不冲的话「已收 = 订购」会让这单看起来收齐了，
          // 采购建议也会把退掉的货继续当成在途
          await tx.purchaseOrderLine.update({
            where: { id: p.lineId },
            data: { receivedQty: { decrement: p.qty } },
          })
          created.push({ productId: p.productId, stockQty })
        }
        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `采购退货 ${po.name}：${planned.map(p => `${p.productName} ×${p.qty}`).join('、')}`
          + `，应退金额 €${refundExTax}${noteSuffix}`,
      })

      return NextResponse.json(serializeApi({
        ok: true,
        purchaseOrderId: id,
        returned: planned.map(p => ({ productId: p.productId, productName: p.productName, qty: p.qty })),
        stockMoves: moves.length,
        /** 应退金额（税前，欧元）。财务据此开负数账单/贷记单——本接口刻意不动账单金额 */
        refundExTax,
      }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-orders/[id]/return]', error)
      return NextResponse.json({ error: '采购退货失败' }, { status: 500 })
    }
  }, { require: 'purchase.order.receive' })
}
