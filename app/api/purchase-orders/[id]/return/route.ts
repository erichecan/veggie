/**
 * POST /api/purchase-orders/:id/return —— 采购退货（退给供应商）
 * ============================================================================
 * 台账 F3 验收里点名的一环：「退货能正确冲减库存」。此前**这条路根本不存在** ——
 * 收货只进不出，货收错了/坏了只能靠「报废」记一笔损耗，可那是自家损失，
 * 与「退回给供应商、应付款要跟着减」完全是两回事。
 *
 * 做最小闭环，不新建单据表：
 *   1. 校验退货量 ≤ 该行已收量（不能退比收到的还多）
 *   2. 扣减 Product.qtyOnHand + 记一笔 OUT 流水（负数），先扣这张单收进来的批次，不够再 FEFO 扣别的批次
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
import { toStockQty } from '@/lib/inventory'
import { postStockMove, LOC } from '@/lib/stock-ledger'
import { eurAmount } from '@/lib/fx-eur'
import { syncDraftVendorBillFromPurchaseOrder } from '@/lib/vendor-bill-from-po'
import { lotsReceivedForPurchaseLine } from '@/lib/purchase/receive-purchase-order'

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
        /** 退货里冲减下单数量 / 应付的那部分（扣掉先退的超收部分） */
        billedQty: number
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
        // 超收部分（已收 > 订购，20261020）：先退这部分，它既不在下单数量里、也从没进过账单，
        // 退掉只是把多收的货还回去，下单数量和应付都不该动。原来一律按「下单量 − 退货量」下修，
        // 订购 50 误收 500 再退 450，下单数量被减成 0、金额 €0，还报「应退 €2250」
        const excess = Math.max(0, received - toNum(poLine.orderedQty))
        const billedQty = Math.max(0, Math.round((qty - excess) * 1000) / 1000)
        planned.push({
          lineId: poLine.id,
          productId,
          productName: poLine.productName,
          qty,
          billedQty,
          uomId: poLine.uomId ?? null,
          unitCost: toNum(poLine.unitCostEur ?? poLine.unitCost),
          orderedQty: toNum(poLine.orderedQty),
          nativeUnitCost: toNum(poLine.unitCost),
          taxRate: toNum(poLine.taxRate),
        })
      }

      const refundExTax = Math.round(planned.reduce((s, p) => s + p.billedQty * p.unitCost, 0) * 100) / 100
      const noteSuffix = reason ? ` - ${reason}` : ''

      let draftBillSynced: string | null = null
      const moves = await prisma.$transaction(async (tx) => {
        const created: Array<{ productId: string; stockQty: number }> = []
        for (const p of planned) {
          // 退货量按采购单位记，库存按基准单位记 —— 与收货侧同一套换算（I3 修过的那个坑）
          const stockQty = await toStockQty(tx as never, p.productId, p.qty, p.uomId)

          // 入账：仓库 → 供应商（lib/stock-ledger.ts）。先扣这一行收货收进来的批次（最近一次收货的先扣），
          // 不够——这批货已被卖掉一部分——再 FEFO 扣别的批次；逐批拆流水（批次覆盖不到的部分记无批次流水）。
          // 20261022 前一律 FEFO：误收 500 箱进 LOT-01106 再退 450，扣的却是更早的 LOT-01105。
          // 按这张 PO 的采购价估值，冲回收货时的 Dr 1300 / Cr 2150
          const ownLots = await lotsReceivedForPurchaseLine(tx, { id: p.lineId, productId: p.productId, purchaseOrderId: id })
          await postStockMove(tx, {
            productId: p.productId,
            productName: p.productName,
            qty: stockQty,
            from: LOC.STOCK,
            to: LOC.VENDORS,
            type: 'OUT',
            lot: { mode: 'fefo', preferLotIds: ownLots },
            unitCost: stockQty > 0 && p.unitCost > 0 ? (p.unitCost * p.qty) / stockQty : null,
            movedAt: new Date(),
            note: `采购退货 PO ${po.name}${noteSuffix}`,
            sourceType: 'PURCHASE_RETURN',
            sourceId: id,
            sourceRef: po.name,
            purchaseOrderLineId: p.lineId,
            partnerId: po.supplierId ?? null,
            uomQty: p.qty,
            uomId: p.uomId,
            userId: user.userId,
            createdBy: user.name ?? user.email,
          })

          // 回冲已收量：不冲的话「已收 = 订购」会让这单看起来收齐了，
          // 采购建议也会把退掉的货继续当成在途
          //
          // 未开正式账单时（决策#3）顺带下修 orderedQty 并按原币重算行金额——
          // 用原生 unitCost/taxRate（不是 refundExTax 用的欧元折算价），
          // 与 PUT 编辑接口的算法保持一致。orderedQty 理论上不会退到负数
          // （按 billedQty 下修，超收部分不动下单量），Math.max(0, …) 只是兜底。
          let lineAmountUpdate: Record<string, unknown> = {}
          if (!hasIssuedBill && p.billedQty > 0) {
            const newOrderedQty = Math.max(0, p.orderedQty - p.billedQty)
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

        // 草稿账单跟着改（20261020）：PO 确认时自动生成的 DRAFT 账单是按当时的下单量开的，
        // 下单量被退货下修后不同步，财务过账时就按旧数量付款
        if (!hasIssuedBill && planned.some(p => p.billedQty > 0)) {
          draftBillSynced = await syncDraftVendorBillFromPurchaseOrder(tx as never, id)
        }

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `采购退货 ${po.name}：${planned.map(p => `${p.productName} ×${p.qty}${p.qty > p.billedQty ? `（其中超收 ${Math.round((p.qty - p.billedQty) * 1000) / 1000}）` : ''}`).join('、')}`
          + `，应退金额 €${refundExTax}${noteSuffix}`
          + (!planned.some(p => p.billedQty > 0)
            ? '（退回的都是超收部分，下单数量与金额不变）'
            : hasIssuedBill
              ? '（账单已开票，仅冲减库存，金额需财务手动处理）'
              : `（已同步下修下单数量与金额${draftBillSynced ? `，草稿账单 ${draftBillSynced} 已同步` : ''}）`),
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
