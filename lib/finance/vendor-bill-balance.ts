/**
 * 供应商账单余额：唯一的重算入口 —— 20261014（复式改造 L2）
 * ============================================================================
 * VendorBill.amountPaid / amountDue 是缓存，真相是 VendorPayment 流水（负数 = 冲销）。
 * 写完流水后在同一事务里调 recomputeVendorBillBalance，由它加总写回并切换 POSTED/PAID。
 * ⛔ 别处不要直接写这两个字段（建账单时置初值除外），见 tests/ledger-balance-writers.test.ts。
 */
import { round2, toNum } from '@/lib/decimal-helpers'

const EPS = 0.005

export function computeVendorBillBalance(totalIncTax: number, payments: number[]) {
  const amountPaid = round2(payments.reduce((s, a) => s + a, 0))
  const raw = round2(totalIncTax - amountPaid)
  return { amountPaid, amountDue: Math.max(0, raw), settled: raw <= EPS }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function recomputeVendorBillBalance(db: Db, billId: string) {
  const bill = await db.vendorBill.findUnique({ where: { id: billId }, select: { status: true, totalIncTax: true } })
  if (!bill) throw Object.assign(new Error('账单不存在'), { status: 404 })
  const pays = await db.vendorPayment.findMany({ where: { vendorBillId: billId }, select: { amount: true } })
  const bal = computeVendorBillBalance(toNum(bill.totalIncTax), pays.map((p: { amount: unknown }) => toNum(p.amount)))
  const cur = String(bill.status)
  const status = cur === 'POSTED' && bal.settled ? 'PAID' : cur === 'PAID' && !bal.settled ? 'POSTED' : cur
  return db.vendorBill.update({
    where: { id: billId },
    data: {
      amountPaid: bal.amountPaid,
      amountDue: bal.amountDue,
      ...(status !== cur ? { status, paidAt: status === 'PAID' ? new Date() : null } : {}),
    },
  })
}
