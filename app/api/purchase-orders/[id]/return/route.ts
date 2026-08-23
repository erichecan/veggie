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
 * ⛔ 不动**已出正式账单**的金额：账单一旦过账/已付，是财务凭证，退货后的抵扣该由财务
 *    开负数账单/贷记单处理，在这里偷偷改金额会让已过账的凭证与账面对不上。
 *
 * 20260823 补（DEV-PLAN 决策#3）：PO 还没出正式账单（没有 VendorBill，或只有 DRAFT/CANCELLED
 * 状态的）时，退货**顺带下修对应行的 orderedQty 并重算金额**——用户原话「修正采购单的数量」
 * 字面指的就是下单数量本身，此时改了也不会让明细跟已发账单对不上。一旦出现 POSTED/PAID
 * 状态的账单，退回到"只改库存、算 refundExTax 给财务参考"的老路径，两条路径共用同一个入口，
 * 不引入第二套编辑机制。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { consumeLotsFIFO, toStockQty } from '@/lib/inventory'
import { eurAmount } from '@/lib/fx-eur'

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

      // 精确判断"是否已开票"：不能只看 PO 状态 !== 'INVOICED'——CONFIRMED 转 INVOICED 前
      // 系统会自动建**草稿** VendorBill（见 purchase-orders/[id]/route.ts confirm 分支），
      // 那张草稿从未真正发出去，账面上不存在，退货金额照样能改。真正拦住的是
      // POSTED/PAID：金额已经出去，明细不能再跟已发账单对不上（风险#2）。
      const issuedBill = await prisma.vendorBill.findFirst({
        where: { purchaseOrderId: id, status: { in: ['POSTED', 'PAID'] } },
        select: { id: true },
      })
      const hasIssuedBill = !!issuedBill
      const rate = po.exchangeRatePending ? null : toNum(po.exchangeRate)

      // 先全量校验再落库：一行不合法就整单拒绝，不做「前两行成功第三行失败」的半吊子结果
      const planned: Array<{
        lineId: string; productId: string; productName: string; qty: number
        uomId: string | null; unitCost: number
        orderedQty: number; nativeUnitCost: number; taxRate: number
      }> = []
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
          orderedQty: toNum(poLine.orderedQty),
          nativeUnitCost: toNum(poLine.unitCost),
          taxRate: toNum(poLine.taxRate),
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
          const consumed = await consumeLotsFIFO(tx as never, p.productId, stockQty)

          // ⛔ 流水必须**按批次逐笔记**，不能只记一笔 lotId=null 的总额。
          // 第一版就是那么写的，结果 `Lot.currentQty == Σ该批次流水` 当场被破坏：
          // 批次余量扣到 26，而挂在它名下的流水仍只有收货那笔 +30。
          // consumeLotsFIFO 返回的就是「扣到了哪几个批次各多少」，用它拆流水。
          const consumedQty = consumed.reduce((sum, c) => sum + c.qty, 0)
          for (const c of consumed) {
            await tx.stockMove.create({
              data: {
                productId: p.productId,
                productName: p.productName,
                type: 'OUT',
                qty: -c.qty,
                lotId: c.lotId,
                movedAt: new Date(),
                note: `采购退货 PO ${po.name} / 批次 ${c.lotNumber}${noteSuffix}`,
                sourceType: 'PURCHASE_RETURN',
                sourceId: id,
                sourceRef: po.name,
              },
            })
          }
          // 批次覆盖不到的部分（历史库存没有批次时）单记一笔无批次流水，
          // 保证 qtyOnHand 与 Σ流水 仍然相等
          const uncovered = Math.round((stockQty - consumedQty) * 1000) / 1000
          if (uncovered > 0) {
            await tx.stockMove.create({
              data: {
                productId: p.productId,
                productName: p.productName,
                type: 'OUT',
                qty: -uncovered,
                movedAt: new Date(),
                note: `采购退货 PO ${po.name}（无批次部分）${noteSuffix}`,
                sourceType: 'PURCHASE_RETURN',
                sourceId: id,
                sourceRef: po.name,
              },
            })
          }

          // 回冲已收量：不冲的话「已收 = 订购」会让这单看起来收齐了，
          // 采购建议也会把退掉的货继续当成在途
          //
          // 未开正式账单时（决策#3）顺带下修 orderedQty 并按原币重算行金额——
          // 用原生 unitCost/taxRate（不是 refundExTax 用的欧元折算价），
          // 与 PUT 编辑接口的算法保持一致。orderedQty 理论上不会退到负数
          // （已校验 qty ≤ receivedQty ≤ orderedQty 的正常情形），Math.max(0, …) 只是兜底。
          let lineAmountUpdate: Record<string, unknown> = {}
          if (!hasIssuedBill) {
            const newOrderedQty = Math.max(0, p.orderedQty - p.qty)
            const subtotalExTax = newOrderedQty * p.nativeUnitCost
            const taxAmount = subtotalExTax * p.taxRate / 100
            const subtotalIncTax = subtotalExTax + taxAmount
            lineAmountUpdate = {
              orderedQty: newOrderedQty,
              subtotalExTax, taxAmount, subtotalIncTax,
              subtotalExTaxEur: eurAmount(subtotalExTax, rate),
              taxAmountEur: eurAmount(taxAmount, rate),
              subtotalIncTaxEur: eurAmount(subtotalIncTax, rate),
            }
          }
          await tx.purchaseOrderLine.update({
            where: { id: p.lineId },
            data: { receivedQty: { decrement: p.qty }, ...lineAmountUpdate },
          })
          created.push({ productId: p.productId, stockQty })
        }

        // 行金额变了，PO 表头合计要跟着重算（从全部行重新汇总，不只是本次退货的行）
        if (!hasIssuedBill) {
          const freshLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } })
          const subtotalExTax = freshLines.reduce((s, l) => s + toNum(l.subtotalExTax), 0)
          const totalTax = freshLines.reduce((s, l) => s + toNum(l.taxAmount), 0)
          const totalIncTax = subtotalExTax + totalTax
          await tx.purchaseOrder.update({
            where: { id },
            data: {
              subtotalExTax, totalTax, totalIncTax,
              subtotalExTaxEur: eurAmount(subtotalExTax, rate),
              totalTaxEur: eurAmount(totalTax, rate),
              totalIncTaxEur: eurAmount(totalIncTax, rate),
            },
          })
        }

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `采购退货 ${po.name}：${planned.map(p => `${p.productName} ×${p.qty}`).join('、')}`
          + `，应退金额 €${refundExTax}${noteSuffix}`
          + (hasIssuedBill
            ? '（账单已开票，仅冲减库存，金额需财务手动处理）'
            : '（已同步下修下单数量与金额）'),
      })

      return NextResponse.json(serializeApi({
        ok: true,
        purchaseOrderId: id,
        returned: planned.map(p => ({ productId: p.productId, productName: p.productName, qty: p.qty })),
        stockMoves: moves.length,
        /** 应退金额（税前，欧元）。已开票时财务据此开负数账单/贷记单；未开票时金额已随 orderedQty 同步修正 */
        refundExTax,
        /** true=已同步下修 orderedQty 与金额；false=已开正式账单，仅冲减库存，金额留给财务处理 */
        orderedQtyAdjusted: !hasIssuedBill,
      }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-orders/[id]/return]', error)
      return NextResponse.json({ error: '采购退货失败' }, { status: 500 })
    }
  }, { require: 'purchase.order.receive' })
}
