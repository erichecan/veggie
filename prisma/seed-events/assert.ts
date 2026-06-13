/**
 * 守恒断言：跑完自动校验，任一不过即 process.exit(1)
 * （对应设计文档 §9）
 */
import type { PrismaClient } from '../../lib/generated/prisma/client'
import { MARK } from './context'

const EPS = 0.02
const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPS

export async function runAssertions(prisma: PrismaClient): Promise<void> {
  const fails: string[] = []
  const ok: string[] = []

  // 1. 库存守恒：每商品 qtyOnHand == Σ StockMove.qty
  {
    const sums = await prisma.stockMove.groupBy({ by: ['productId'], _sum: { qty: true } })
    const sumMap = new Map(sums.map((s) => [s.productId, Number(s._sum.qty ?? 0)]))
    const products = await prisma.product.findMany({ select: { id: true, qtyOnHand: true } })
    let bad = 0
    for (const p of products) {
      const expect = sumMap.get(p.id) ?? 0
      if (!near(Number(p.qtyOnHand), expect)) bad++
    }
    bad === 0
      ? ok.push(`库存守恒 ✓（${products.length} 商品）`)
      : fails.push(`库存守恒 ✗：${bad} 个商品 qtyOnHand ≠ ΣStockMove`)
  }

  // 2. 批次守恒：每 Lot currentQty == Σ StockMove.qty(lotId)
  {
    const lots = await prisma.lot.findMany({
      where: { lotNumber: { startsWith: MARK.lotPrefix } },
      select: { id: true, currentQty: true },
    })
    const moves = await prisma.stockMove.groupBy({ by: ['lotId'], _sum: { qty: true } })
    const m = new Map(moves.map((x) => [x.lotId, Number(x._sum.qty ?? 0)]))
    let bad = 0
    for (const lot of lots) if (!near(Number(lot.currentQty), m.get(lot.id) ?? 0)) bad++
    bad === 0
      ? ok.push(`批次守恒 ✓（${lots.length} 批次）`)
      : fails.push(`批次守恒 ✗：${bad} 个 Lot currentQty ≠ ΣStockMove(lot)`)
  }

  // 3 + 4. 发票勾稽
  {
    const invoices = await prisma.invoice.findMany({
      where: { name: { startsWith: MARK.invPrefix } },
      select: {
        id: true,
        name: true,
        saleOrderIds: true,
        subtotalExTax: true,
        totalIncTax: true,
        amountPaid: true,
        amountDue: true,
        payments: { select: { amount: true } },
      },
    })
    let payBad = 0
    let dueBad = 0
    let linkBad = 0
    for (const inv of invoices) {
      const paid = inv.payments.reduce((a, p) => a + Number(p.amount), 0)
      if (!near(paid, Number(inv.amountPaid))) payBad++
      if (!near(Number(inv.amountDue), Number(inv.totalIncTax) - Number(inv.amountPaid))) dueBad++
      if (inv.saleOrderIds.length > 0) {
        const ords = await prisma.order.findMany({
          where: { id: { in: inv.saleOrderIds } },
          select: { totalAmount: true },
        })
        const sum = ords.reduce((a, o) => a + Number(o.totalAmount), 0)
        if (!near(sum, Number(inv.subtotalExTax))) linkBad++
      }
    }
    payBad === 0 ? ok.push(`收款勾稽 ✓（${invoices.length} 发票）`) : fails.push(`收款勾稽 ✗：${payBad} 发票 Σpayments ≠ amountPaid`)
    dueBad === 0 ? ok.push('应付余额 ✓') : fails.push(`应付余额 ✗：${dueBad} 发票 amountDue ≠ incTax-paid`)
    linkBad === 0 ? ok.push('发票↔订单勾稽 ✓') : fails.push(`发票↔订单勾稽 ✗：${linkBad} 发票 subtotalExTax ≠ Σ订单`)
  }

  // 5. 借贷平衡
  {
    const entries = await prisma.journalEntry.findMany({
      where: { narration: { contains: MARK.jeMarker } },
      select: { id: true, totalDebit: true, totalCredit: true, lines: { select: { debit: true, credit: true } } },
    })
    let bad = 0
    for (const e of entries) {
      const d = e.lines.reduce((a, l) => a + Number(l.debit), 0)
      const c = e.lines.reduce((a, l) => a + Number(l.credit), 0)
      if (!near(d, c) || !near(d, Number(e.totalDebit))) bad++
    }
    bad === 0
      ? ok.push(`借贷平衡 ✓（${entries.length} 凭证）`)
      : fails.push(`借贷平衡 ✗：${bad} 凭证 Σ借 ≠ Σ贷`)
  }

  // 6. 状态机自洽：COMPLETED/LOCKED 订单行 deliveredQty == orderedQty
  {
    const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*)::bigint AS cnt FROM "OrderLine" ol
       JOIN "Order" o ON o.id = ol."orderId"
       WHERE o."externalRef" = $1 AND o.status IN ('COMPLETED','LOCKED')
         AND ol."deliveredQty" <> ol."orderedQty"`,
      MARK.orderRef,
    )
    const bad = Number(rows[0]?.cnt ?? 0)
    bad === 0
      ? ok.push('状态机自洽 ✓（完成单 deliveredQty=orderedQty）')
      : fails.push(`状态机自洽 ✗：${bad} 行完成单 deliveredQty ≠ orderedQty`)
  }

  // 7. 对账闭环
  {
    const stmts = await prisma.statement.findMany({
      where: { tenantId: MARK.tenant },
      select: { openingBalance: true, totalSales: true, totalPayments: true, closingBalance: true },
    })
    let bad = 0
    for (const s of stmts) {
      const expect = Number(s.openingBalance) + Number(s.totalSales) - Number(s.totalPayments)
      if (!near(expect, Number(s.closingBalance))) bad++
    }
    bad === 0
      ? ok.push(`对账闭环 ✓（${stmts.length} 对账单）`)
      : fails.push(`对账闭环 ✗：${bad} 对账单 closing ≠ opening+sales-payments`)
  }

  console.log('\n──── 守恒断言 ────')
  for (const s of ok) console.log('  ' + s)
  if (fails.length > 0) {
    console.error('\n❌ 断言失败：')
    for (const f of fails) console.error('  ' + f)
    process.exit(1)
  }
  console.log('\n✅ 全部守恒断言通过')
}
