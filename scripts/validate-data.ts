/**
 * 数据完整性校验器（独立命令，不依赖种子）
 * ============================================================================
 * 对**全库任意数据**（种子 / 真实导入 / 线上快照）跑一组领域守恒不变量，
 * 输出逐项 通过/违例 报告。可用作：迁移验收测试、线上数据巡检、CI 数据门禁。
 *
 *   npm run db:validate            # 校验全库，发现违例 exit 1
 *
 * 不变量（North Fresh 业务域）：
 *   1 库存守恒    每商品 qtyOnHand == Σ StockMove.qty
 *   2 批次守恒    每 Lot currentQty == Σ StockMove.qty(lotId)
 *   3 收款勾稽    每发票 Σ payments == amountPaid，amountDue == totalIncTax - amountPaid
 *   4 发票↔订单   每发票 subtotalExTax == Σ(saleOrderIds 订单 totalAmount)
 *   5 借贷平衡    每凭证 Σ debit == Σ credit == totalDebit
 *   6 状态机自洽  COMPLETED/LOCKED 订单行 deliveredQty == orderedQty
 *   7 对账闭环    每对账单 closing == opening + sales - payments
 *   8 软引用完整  payments/发票 saleOrderIds 指向真实存在的记录
 *   9 库存非负    在售商品 qtyOnHand >= 0（不得卖超库存）
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

import { checkDriverIdentity } from '../lib/validation/driver-identity'

const MONEY_EPS = 0.02
const QTY_EPS = 0.001
const n = (v: unknown): number => Number(v ?? 0)
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps

interface Check {
  name: string
  pass: boolean
  detail: string
  examples: string[]
}
const checks: Check[] = []
function record(name: string, bad: number, total: number, examples: string[] = []): void {
  checks.push({
    name,
    pass: bad === 0,
    detail: bad === 0 ? `✓ ${total} 条全部一致` : `✗ ${bad}/${total} 违例`,
    examples: examples.slice(0, 3),
  })
}

async function main(): Promise<void> {
  console.log('🔎 数据完整性校验（全库）...\n')

  // 1. 库存守恒
  {
    const sums = await prisma.stockMove.groupBy({ by: ['productId'], _sum: { qty: true } })
    const m = new Map(sums.map((s) => [s.productId, n(s._sum.qty)]))
    const products = await prisma.product.findMany({ select: { id: true, name: true, qtyOnHand: true } })
    const ex: string[] = []
    let bad = 0
    for (const p of products) {
      const expect = m.get(p.id) ?? 0
      if (!near(n(p.qtyOnHand), expect, QTY_EPS)) {
        bad++
        if (ex.length < 3) ex.push(`${p.name}: onHand=${n(p.qtyOnHand)} ≠ Σmoves=${expect}`)
      }
    }
    record('库存守恒  qtyOnHand == ΣStockMove', bad, products.length, ex)
  }

  // 2. 批次守恒
  {
    const lots = await prisma.lot.findMany({ select: { id: true, lotNumber: true, currentQty: true } })
    const sums = await prisma.stockMove.groupBy({ by: ['lotId'], _sum: { qty: true } })
    const m = new Map(sums.map((s) => [s.lotId, n(s._sum.qty)]))
    const ex: string[] = []
    let bad = 0
    for (const lot of lots) {
      const expect = m.get(lot.id) ?? 0
      if (!near(n(lot.currentQty), expect, QTY_EPS)) {
        bad++
        if (ex.length < 3) ex.push(`${lot.lotNumber}: current=${n(lot.currentQty)} ≠ Σmoves=${expect}`)
      }
    }
    record('批次守恒  Lot.currentQty == ΣStockMove(lot)', bad, lots.length, ex)
  }

  // 3. 收款勾稽
  {
    const invoices = await prisma.invoice.findMany({
      select: { id: true, name: true, totalIncTax: true, amountPaid: true, amountDue: true, payments: { select: { amount: true } } },
    })
    const exPay: string[] = []
    const exDue: string[] = []
    let badPay = 0
    let badDue = 0
    for (const inv of invoices) {
      const paid = inv.payments.reduce((a, p) => a + n(p.amount), 0)
      if (!near(paid, n(inv.amountPaid), MONEY_EPS)) {
        badPay++
        if (exPay.length < 3) exPay.push(`${inv.name}: Σpay=${paid.toFixed(2)} ≠ paid=${n(inv.amountPaid).toFixed(2)}`)
      }
      if (!near(n(inv.amountDue), n(inv.totalIncTax) - n(inv.amountPaid), MONEY_EPS)) {
        badDue++
        if (exDue.length < 3) exDue.push(`${inv.name}: due=${n(inv.amountDue).toFixed(2)} ≠ inc-paid`)
      }
    }
    record('收款勾稽  Σpayments == amountPaid', badPay, invoices.length, exPay)
    record('应付余额  amountDue == incTax - amountPaid', badDue, invoices.length, exDue)
  }

  // 3b. 供应商付款勾稽（台账 G2）—— 与上面的应收侧严格对称。
  // amountPaid 从此是 VendorPayment 的汇总，不是一个可以被单独写坏的数字。
  {
    const bills = await prisma.vendorBill.findMany({
      select: { id: true, name: true, totalIncTax: true, amountPaid: true, amountDue: true, payments: { select: { amount: true } } },
    })
    const exPay: string[] = []
    const exDue: string[] = []
    let badPay = 0
    let badDue = 0
    for (const b of bills) {
      const paid = b.payments.reduce((a, p) => a + n(p.amount), 0)
      if (!near(paid, n(b.amountPaid), MONEY_EPS)) {
        badPay++
        if (exPay.length < 3) exPay.push(`${b.name}: Σpay=${paid.toFixed(2)} ≠ paid=${n(b.amountPaid).toFixed(2)}`)
      }
      if (!near(n(b.amountDue), n(b.totalIncTax) - n(b.amountPaid), MONEY_EPS)) {
        badDue++
        if (exDue.length < 3) exDue.push(`${b.name}: due=${n(b.amountDue).toFixed(2)} ≠ inc-paid`)
      }
    }
    record('供应商付款勾稽  ΣVendorPayment == amountPaid', badPay, bills.length, exPay)
    record('供应商账单余额  amountDue == incTax - amountPaid', badDue, bills.length, exDue)
  }

  // 4. 发票↔订单
  {
    const invoices = await prisma.invoice.findMany({ select: { id: true, name: true, saleOrderIds: true, subtotalExTax: true } })
    const ex: string[] = []
    let bad = 0
    let checked = 0
    for (const inv of invoices) {
      if (inv.saleOrderIds.length === 0) continue
      const ords = await prisma.order.findMany({ where: { id: { in: inv.saleOrderIds } }, select: { totalAmount: true } })
      if (ords.length !== inv.saleOrderIds.length) continue // 引用缺失交给 #8
      checked++
      const sum = ords.reduce((a, o) => a + n(o.totalAmount), 0)
      if (!near(sum, n(inv.subtotalExTax), MONEY_EPS)) {
        bad++
        if (ex.length < 3) ex.push(`${inv.name}: Σorders=${sum.toFixed(2)} ≠ exTax=${n(inv.subtotalExTax).toFixed(2)}`)
      }
    }
    record('发票↔订单  subtotalExTax == Σ订单额', bad, checked, ex)
  }

  // 4b. 订单头行一致（台账 X5）
  //
  // 为什么单列一条：#4 拿 `Order.totalAmount` 去对发票，**默认表头本身是对的**。
  // 客户 20260814 那个 bug 破的正是这个前提 —— 编辑订单时表头按前端提交价算、
  // 行按定价引擎的权威价落库，两者就此分叉，而当时没有任何一条不变量看这里，
  // 于是 149,763 张单里烂掉的 2 张一直没人发现（OP-260720-001 存 211.50、行合计 199.00）。
  // 表头是发票、报表、毛利的取数口，行是拣货、打印、核货的取数口 —— 分叉意味着
  // 「按单据发的货」和「按单据收的钱」不是一回事。
  {
    const grouped = await prisma.orderLine.groupBy({
      by: ['orderId'],
      _sum: { subtotal: true },
    })
    const lineSum = new Map(grouped.map(g => [g.orderId, n(g._sum.subtotal)]))
    // 只查有行的订单：一行都没有的单（草稿/导入残留）表头是多少都不构成分叉
    const orders = await prisma.order.findMany({
      where: { id: { in: [...lineSum.keys()] } },
      select: { id: true, code: true, totalAmount: true },
    })
    const ex: string[] = []
    let bad = 0
    for (const o of orders) {
      const sum = lineSum.get(o.id) ?? 0
      if (!near(sum, n(o.totalAmount), MONEY_EPS)) {
        bad++
        if (ex.length < 5) {
          ex.push(`${o.code}: 表头=${n(o.totalAmount).toFixed(2)} ≠ Σ行小计=${sum.toFixed(2)}`)
        }
      }
    }
    record('订单头行一致  totalAmount == Σ行小计', bad, orders.length, ex)
  }

  // 5. 借贷平衡
  {
    const entries = await prisma.journalEntry.findMany({
      select: { name: true, totalDebit: true, totalCredit: true, lines: { select: { debit: true, credit: true } } },
    })
    const ex: string[] = []
    let bad = 0
    for (const e of entries) {
      const d = e.lines.reduce((a, l) => a + n(l.debit), 0)
      const c = e.lines.reduce((a, l) => a + n(l.credit), 0)
      if (!near(d, c, MONEY_EPS) || !near(d, n(e.totalDebit), MONEY_EPS)) {
        bad++
        if (ex.length < 3) ex.push(`${e.name}: Σ借=${d.toFixed(2)} Σ贷=${c.toFixed(2)}`)
      }
    }
    record('借贷平衡  Σdebit == Σcredit', bad, entries.length, ex)
  }

  // 6. 状态机自洽（仅本系统产生的完成单）
  //    本系统订单走到 COMPLETED 时代码回填 deliveredQty=orderedQty，故此不变量成立。
  //    但 Odoo 导入的 LOCKED 历史单不走本系统状态机：其 deliveredQty 是 Odoo 真实
  //    qty_delivered（合法存在部分交付/未交付，且按订单量开票），强制 ==orderedQty
  //    会篡改真实历史，故豁免 externalRef 以 __export__.sale_order 开头的历史导入单。
  {
    const EXCLUDE_ODOO = `COALESCE(o."externalRef", '') NOT LIKE '\\_\\_export\\_\\_.sale\\_order%' ESCAPE '\\'`
    const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*)::bigint AS cnt FROM "OrderLine" ol
       JOIN "Order" o ON o.id = ol."orderId"
       WHERE o.status IN ('COMPLETED','LOCKED') AND ol."deliveredQty" <> ol."orderedQty"
         AND ${EXCLUDE_ODOO}`,
    )
    const bad = Number(rows[0]?.cnt ?? 0)
    const totRows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*)::bigint AS cnt FROM "Order" o
       WHERE o.status IN ('COMPLETED','LOCKED') AND ${EXCLUDE_ODOO}`,
    )
    const tot = Number(totRows[0]?.cnt ?? 0)
    record('状态机自洽  完成单 deliveredQty == orderedQty（本系统单）', bad, tot, bad ? [`${bad} 行不一致`] : [])
  }

  // 7. 对账闭环
  {
    const stmts = await prisma.statement.findMany({ select: { customerName: true, openingBalance: true, totalSales: true, totalPayments: true, closingBalance: true } })
    const ex: string[] = []
    let bad = 0
    for (const s of stmts) {
      const expect = n(s.openingBalance) + n(s.totalSales) - n(s.totalPayments)
      if (!near(expect, n(s.closingBalance), MONEY_EPS)) {
        bad++
        if (ex.length < 3) ex.push(`${s.customerName}: closing=${n(s.closingBalance).toFixed(2)} ≠ open+sales-pay`)
      }
    }
    record('对账闭环  closing == opening + sales - payments', bad, stmts.length, ex)
  }

  // 8. 软引用完整：发票 saleOrderIds 指向真实订单
  {
    const invoices = await prisma.invoice.findMany({ select: { name: true, saleOrderIds: true } })
    const ex: string[] = []
    let bad = 0
    for (const inv of invoices) {
      if (inv.saleOrderIds.length === 0) continue
      const cnt = await prisma.order.count({ where: { id: { in: inv.saleOrderIds } } })
      if (cnt !== inv.saleOrderIds.length) {
        bad++
        if (ex.length < 3) ex.push(`${inv.name}: ${inv.saleOrderIds.length - cnt} 个订单引用缺失`)
      }
    }
    record('软引用完整  发票 saleOrderIds 指向真实订单', bad, invoices.length, ex)
  }

  // 9. 库存非负：在售商品不得负库存（卖超 = 业务不自洽）
  {
    const products = await prisma.product.findMany({
      where: { active: true, status: 'ACTIVE' },
      select: { name: true, qtyOnHand: true },
    })
    const ex: string[] = []
    let bad = 0
    for (const p of products) {
      if (n(p.qtyOnHand) < -QTY_EPS) {
        bad++
        if (ex.length < 3) ex.push(`${p.name}: onHand=${n(p.qtyOnHand)}`)
      }
    }
    record('库存非负  在售商品 qtyOnHand >= 0', bad, products.length, ex)
  }

  // 10. 调度单一归属：一张订单至多属一个 wave（SSOT P0-1，wave.orderIds 是唯一真相）
  {
    const waves = await prisma.pickingWave.findMany({ select: { name: true, orderIds: true } })
    const seen = new Map<string, string>()
    const dupOrders = new Set<string>()
    const ex: string[] = []
    for (const w of waves) {
      for (const oid of (w.orderIds as string[])) {
        if (seen.has(oid)) {
          if (!dupOrders.has(oid)) {
            dupOrders.add(oid)
            if (ex.length < 3) ex.push(`订单 ${oid} 同时在「${seen.get(oid)}」和「${w.name}」`)
          }
        } else {
          seen.set(oid, w.name ?? '?')
        }
      }
    }
    record('调度单一归属  一单至多属一个 wave', dupOrders.size, seen.size, ex)
  }

  // 11. 司机身份单一真相（台账 C6）——「司机不能有两套」是需求点名翻过车的地方
  {
    const findings = await checkDriverIdentity(prisma)
    for (const f of findings) {
      if (f.advisory) {
        // 提示项不参与成败：改名不级联、下单意向与实际不同，都是设计允许的
        checks.push({
          name: `（提示）${f.title}`,
          pass: true,
          detail: f.bad === 0 ? `✓ ${f.total} 条无差异` : `ℹ ${f.bad}/${f.total} 条不同（不算违例）`,
          examples: f.examples.slice(0, 2),
        })
        continue
      }
      record(`司机真相  ${f.title}`, f.bad, f.total, f.examples)
    }
  }

  // 输出报告
  console.log('──── 校验报告 ────')
  let failed = 0
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name.padEnd(40)} ${c.detail}`)
    for (const e of c.examples) console.log(`        · ${e}`)
    if (!c.pass) failed++
  }
  console.log('')
  if (failed > 0) {
    console.error(`❌ ${failed} 项不变量被破坏 —— 数据不健康，不能直接驱动流程/报表。`)
    await prisma.$disconnect()
    process.exit(1)
  }
  console.log('✅ 全部不变量通过 —— 数据自洽，可驱动完整业务流程与报表。')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('💥 校验器异常：', e)
  await prisma.$disconnect()
  process.exit(1)
})
