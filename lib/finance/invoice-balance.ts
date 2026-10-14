/**
 * 发票余额：唯一的重算入口 —— 20261014（复式改造 L1/L2）
 * ============================================================================
 * Invoice.amountPaid / amountCredited / amountDue 都是**缓存**，真相是两张明细（外加迁移时一次性
 * 记下的期初 openingPaid / openingCredited——Odoo 导入的历史发票有已收金额却没有 Payment 行，
 * 不记期初的话，第一次重算就会把它们打回「未付」）：
 *   - Payment（invoiceId 指向本发票：普通收款、司机收款核销、预收款冲抵）
 *   - CreditNoteAllocation（kind=INVOICE，贷记单抵扣）
 * 以前三处收款路径各自 `amountPaid + amount` 算一遍，贷记单根本不碰发票，
 * 结果「总账应收 ≠ Σ 发票未付」。现在任何改了明细的地方，写完明细后调
 * recomputeInvoiceBalance(tx, id)，由它从明细加总写回缓存和 PAID/POSTED 状态。
 *
 * ⛔ 不要在别处直接写 amountPaid / amountDue / amountCredited（建发票时置初值除外）；
 * tests/ledger-balance-writers.test.ts 会扫描代码，漏网直接测试失败。
 */
import { round2, toNum } from '@/lib/decimal-helpers'

const EPS = 0.005

export interface InvoiceBalanceInput {
  totalIncTax: number
  payments: number[]
  creditAllocations: number[]
  /** 期初（复式改造前导入、没有明细）的已收 / 已冲减，见 schema Invoice.openingPaid */
  openingPaid?: number
  openingCredited?: number
}

export interface InvoiceBalance {
  amountPaid: number
  amountCredited: number
  amountDue: number
  settled: boolean
}

export function computeInvoiceBalance(input: InvoiceBalanceInput): InvoiceBalance {
  const amountPaid = round2((input.openingPaid ?? 0) + input.payments.reduce((s, a) => s + a, 0))
  const amountCredited = round2((input.openingCredited ?? 0) + input.creditAllocations.reduce((s, a) => s + a, 0))
  const raw = round2(input.totalIncTax - amountPaid - amountCredited)
  return { amountPaid, amountCredited, amountDue: Math.max(0, raw), settled: raw <= EPS }
}

/** 只有已过账的发票会在 POSTED ⇄ PAID 之间按余额自动切换；草稿/作废不动状态 */
export function nextInvoiceStatus(current: string, settled: boolean): string {
  if (current === 'POSTED' && settled) return 'PAID'
  if (current === 'PAID' && !settled) return 'POSTED'
  return current
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function readInvoiceBalance(db: Db, invoiceId: string): Promise<(InvoiceBalance & { status: string; totalIncTax: number; paidAt: string | null }) | null> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true, totalIncTax: true, paidAt: true, openingPaid: true, openingCredited: true },
  })
  if (!invoice) return null
  const [payments, allocations] = await Promise.all([
    db.payment.findMany({ where: { invoiceId }, select: { amount: true } }),
    db.creditNoteAllocation.findMany({ where: { invoiceId, kind: 'INVOICE' }, select: { amount: true } }),
  ])
  const totalIncTax = toNum(invoice.totalIncTax)
  const bal = computeInvoiceBalance({
    totalIncTax,
    openingPaid: toNum(invoice.openingPaid),
    openingCredited: toNum(invoice.openingCredited),
    payments: payments.map((p: { amount: unknown }) => toNum(p.amount)),
    creditAllocations: allocations.map((a: { amount: unknown }) => toNum(a.amount)),
  })
  return { ...bal, status: String(invoice.status), totalIncTax, paidAt: invoice.paidAt ?? null }
}

/**
 * 从明细重算并写回发票缓存余额与 POSTED/PAID 状态。必须在写明细的同一个事务里调用。
 * 返回更新后的发票。
 */
export async function recomputeInvoiceBalance(db: Db, invoiceId: string) {
  const cur = await readInvoiceBalance(db, invoiceId)
  if (!cur) throw Object.assign(new Error('发票不存在'), { status: 404 })
  const status = nextInvoiceStatus(cur.status, cur.settled)
  return db.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid: cur.amountPaid,
      amountCredited: cur.amountCredited,
      amountDue: cur.amountDue,
      ...(status !== cur.status ? { status } : {}),
      ...(status === 'PAID' && cur.status !== 'PAID' ? { paidAt: new Date().toISOString() } : {}),
      ...(status === 'POSTED' && cur.status === 'PAID' ? { paidAt: null } : {}),
    },
  })
}
