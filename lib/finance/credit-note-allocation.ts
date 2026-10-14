/**
 * 贷记单抵扣发票 / 退款 —— 20261014（复式改造 L1）
 * ============================================================================
 * 确认贷记单时总账已 Dr 收入+VAT / Cr 1100 应收，但贷记单从不关联发票，发票 amountDue 不减，
 * 「总账应收 ≠ Σ 发票未付」。这里把贷记单的每一笔去向记进 CreditNoteAllocation：
 *   - 抵扣发票（INVOICE）：应收子账内部核销，不出凭证；发票余额由 recomputeInvoiceBalance 从明细重算
 *   - 退款（REFUND）：把剩余贷项退给客户，出凭证 Dr 1100 / Cr 1200
 * 撤销 = 追加一条负数行（reversalOfId 指回原行，唯一约束保证一行只能被撤一次）。
 * 剩余可用 = totalIncTax − Σ allocations；用完自动 SETTLED，撤销后回到 CONFIRMED。
 */
import { round2, toNum } from '@/lib/decimal-helpers'
import { recomputeInvoiceBalance } from './invoice-balance'
import { postCreditNoteRefundToJournal } from '@/lib/accounting'

const EPS = 0.005

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
interface Actor { userId: string; name?: string | null; email?: string | null }

export const REFUND_METHODS = ['cash', 'transfer', 'other'] as const

export function creditNoteRemaining(totalIncTax: number, allocations: number[]): number {
  return round2(totalIncTax - allocations.reduce((s, a) => s + a, 0))
}

/** 抵扣/退款都只能动「已确认」的贷记单；历史上被手工标成 SETTLED 但一分没抵的，也允许补抵 */
function assertUsable(cn: { status: string }) {
  if (!['CONFIRMED', 'SETTLED'].includes(String(cn.status))) {
    throw Object.assign(new Error(`贷记单状态为 ${cn.status}，只有已确认的贷记单可以抵扣或退款`), { status: 400 })
  }
}

async function lockCreditNote(db: Db, creditNoteId: string) {
  // 行锁：两个人同时抵扣同一张贷记单，必须排队，否则都读到同一个剩余额，超额校验会同时通过
  await db.$queryRaw`SELECT id FROM "CreditNote" WHERE id = ${creditNoteId} FOR UPDATE`
  const cn = await db.creditNote.findUnique({
    where: { id: creditNoteId },
    select: { id: true, name: true, status: true, customerId: true, totalIncTax: true },
  })
  if (!cn) throw Object.assign(new Error('贷记单不存在'), { status: 404 })
  const allocs = await db.creditNoteAllocation.findMany({ where: { creditNoteId }, select: { amount: true } })
  const remaining = creditNoteRemaining(toNum(cn.totalIncTax), allocs.map((a: { amount: unknown }) => toNum(a.amount)))
  return { cn, remaining }
}

async function syncCreditNoteStatus(db: Db, creditNoteId: string) {
  const { cn, remaining } = await lockCreditNote(db, creditNoteId)
  const want = remaining <= EPS ? 'SETTLED' : 'CONFIRMED'
  if (String(cn.status) !== want && ['CONFIRMED', 'SETTLED'].includes(String(cn.status))) {
    await db.creditNote.update({ where: { id: creditNoteId }, data: { status: want } })
  }
  return remaining
}

export async function allocateCreditNoteToInvoice(
  db: Db,
  params: { creditNoteId: string; invoiceId: string; amount: number; note?: string | null; actor: Actor },
) {
  const amount = round2(params.amount)
  if (!(amount > 0)) throw Object.assign(new Error('抵扣金额必须大于 0'), { status: 400 })
  const { cn, remaining } = await lockCreditNote(db, params.creditNoteId)
  assertUsable(cn)
  if (amount > remaining + EPS) {
    throw Object.assign(new Error(`抵扣超额：贷记单剩余 €${remaining.toFixed(2)}，本次 €${amount.toFixed(2)}`), { status: 400 })
  }
  await db.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${params.invoiceId} FOR UPDATE`
  const invoice = await db.invoice.findUnique({
    where: { id: params.invoiceId },
    select: { id: true, name: true, customerId: true, status: true, amountDue: true },
  })
  if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
  if (invoice.customerId !== cn.customerId) {
    throw Object.assign(new Error('贷记单与发票不是同一个客户'), { status: 400 })
  }
  if (!['POSTED', 'PAID'].includes(String(invoice.status))) {
    throw Object.assign(new Error('只能抵扣已过账（POSTED）的发票'), { status: 400 })
  }
  const due = toNum(invoice.amountDue)
  if (amount > due + EPS) {
    throw Object.assign(new Error(`抵扣超额：发票 ${invoice.name} 未付 €${due.toFixed(2)}，本次 €${amount.toFixed(2)}`), { status: 400 })
  }
  const allocation = await db.creditNoteAllocation.create({
    data: {
      creditNoteId: cn.id, kind: 'INVOICE', invoiceId: invoice.id, amount,
      note: params.note ?? null, createdBy: params.actor.name ?? params.actor.email ?? params.actor.userId,
    },
  })
  const invoiceAfter = await recomputeInvoiceBalance(db, invoice.id)
  const remainingAfter = await syncCreditNoteStatus(db, cn.id)
  return { allocation, invoice: invoiceAfter, remaining: remainingAfter, creditNoteName: cn.name, invoiceName: invoice.name }
}

export async function refundCreditNote(
  db: Db,
  params: { creditNoteId: string; amount: number; method: string; note?: string | null; actor: Actor },
) {
  const amount = round2(params.amount)
  if (!(amount > 0)) throw Object.assign(new Error('退款金额必须大于 0'), { status: 400 })
  if (!REFUND_METHODS.includes(params.method as never)) {
    throw Object.assign(new Error(`退款方式无效（${REFUND_METHODS.join('/')}）`), { status: 400 })
  }
  const { cn, remaining } = await lockCreditNote(db, params.creditNoteId)
  assertUsable(cn)
  if (amount > remaining + EPS) {
    throw Object.assign(new Error(`退款超额：贷记单剩余 €${remaining.toFixed(2)}，本次 €${amount.toFixed(2)}`), { status: 400 })
  }
  const allocation = await db.creditNoteAllocation.create({
    data: {
      creditNoteId: cn.id, kind: 'REFUND', amount, method: params.method,
      note: params.note ?? null, createdBy: params.actor.name ?? params.actor.email ?? params.actor.userId,
    },
  })
  const journalEntry = await postCreditNoteRefundToJournal(
    db, { id: allocation.id, creditNoteName: cn.name, customerId: cn.customerId, amount }, params.actor.userId,
  )
  const remainingAfter = await syncCreditNoteStatus(db, cn.id)
  return { allocation, journalEntry, remaining: remainingAfter, creditNoteName: cn.name }
}

export async function reverseCreditNoteAllocation(
  db: Db,
  params: { allocationId: string; note?: string | null; actor: Actor },
) {
  const orig = await db.creditNoteAllocation.findUnique({ where: { id: params.allocationId } })
  if (!orig) throw Object.assign(new Error('抵扣记录不存在'), { status: 404 })
  if (orig.reversalOfId || toNum(orig.amount) <= 0) {
    throw Object.assign(new Error('冲正记录本身不能再撤销'), { status: 400 })
  }
  const { cn } = await lockCreditNote(db, orig.creditNoteId)
  const already = await db.creditNoteAllocation.findUnique({ where: { reversalOfId: orig.id } })
  if (already) throw Object.assign(new Error('这条记录已经撤销过了'), { status: 409 })
  const amount = -toNum(orig.amount)
  const reversal = await db.creditNoteAllocation.create({
    data: {
      creditNoteId: orig.creditNoteId, kind: orig.kind, invoiceId: orig.invoiceId, amount,
      method: orig.method, reversalOfId: orig.id,
      note: params.note ?? null, createdBy: params.actor.name ?? params.actor.email ?? params.actor.userId,
    },
  })
  let journalEntry = null
  if (orig.kind === 'REFUND') {
    journalEntry = await postCreditNoteRefundToJournal(
      db, { id: reversal.id, creditNoteName: cn.name, customerId: cn.customerId, amount }, params.actor.userId,
    )
  }
  const invoice = orig.invoiceId ? await recomputeInvoiceBalance(db, orig.invoiceId) : null
  const remaining = await syncCreditNoteStatus(db, orig.creditNoteId)
  return { reversal, invoice, journalEntry, remaining, creditNoteName: cn.name }
}

/**
 * 给贷记单推荐可抵扣的发票：同客户、已过账未付清；来源订单对得上的排最前，其余按开票早晚。
 */
export async function suggestInvoicesForCreditNote(db: Db, creditNoteId: string) {
  const cn = await db.creditNote.findUnique({
    where: { id: creditNoteId },
    select: { customerId: true, lines: { select: { sourceOrderId: true } } },
  })
  if (!cn) return []
  const sourceOrders = new Set<string>(cn.lines.map((l: { sourceOrderId: string | null }) => l.sourceOrderId).filter(Boolean))
  const invoices = await db.invoice.findMany({
    where: { customerId: cn.customerId, status: 'POSTED', amountDue: { gt: 0 } },
    select: { id: true, name: true, amountDue: true, totalIncTax: true, dueDate: true, createdAt: true, saleOrderIds: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  return invoices
    .map((i: { saleOrderIds: string[] }) => ({ ...i, matchesSourceOrder: i.saleOrderIds.some(o => sourceOrders.has(o)) }))
    .sort((a: { matchesSourceOrder: boolean }, b: { matchesSourceOrder: boolean }) => Number(b.matchesSourceOrder) - Number(a.matchesSourceOrder))
}
