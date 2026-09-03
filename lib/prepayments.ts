/**
 * 客户预付款——余额计算与冲抵校验（纯函数）
 * ================================================================================
 * 预付款余额 = 累计收到（source=PREPAYMENT_RECEIVED） − 累计已冲抵
 * （source=PREPAYMENT_APPLIED）。记账方向见 lib/accounting.ts 的
 * postPaymentToJournal（收到，Dr Bank/Cr 2300）与
 * postPrepaymentApplicationToJournal（冲抵，Dr 2300/Cr AR）。
 */

import { round2, toNum } from './decimal-helpers'
import { postPaymentToJournal, postPrepaymentApplicationToJournal } from './accounting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any

export interface PrepaymentSourceAmount {
  source: string
  amount: number
}

/** 累计收到 − 累计已冲抵。其余 source（如 CASH）不参与计算。 */
export function computePrepaymentBalance(payments: PrepaymentSourceAmount[]): number {
  let received = 0
  let applied = 0
  for (const p of payments) {
    if (p.source === 'PREPAYMENT_RECEIVED') received += p.amount
    else if (p.source === 'PREPAYMENT_APPLIED') applied += p.amount
  }
  return round2(received - applied)
}

export class PrepaymentValidationError extends Error {}

/**
 * 冲抵校验：金额必须 >0，且同时不能超过「当前预付款余额」与「发票剩余应付」——
 * 超过前者是在冲抵不存在的钱，超过后者是在发票上多冲了钱。
 */
export function validatePrepaymentApplication(params: {
  amount: number
  availableBalance: number
  invoiceAmountDue: number
}): void {
  const { amount, availableBalance, invoiceAmountDue } = params
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PrepaymentValidationError('冲抵金额必须大于 0')
  }
  if (amount > availableBalance + 0.005) {
    throw new PrepaymentValidationError(
      `冲抵金额 €${amount.toFixed(2)} 超过预付款余额 €${availableBalance.toFixed(2)}`,
    )
  }
  if (amount > invoiceAmountDue + 0.005) {
    throw new PrepaymentValidationError(
      `冲抵金额 €${amount.toFixed(2)} 超过发票剩余应付 €${invoiceAmountDue.toFixed(2)}`,
    )
  }
}

interface Actor {
  userId: string
  name?: string | null
  email?: string | null
}

/**
 * 登记收到客户预收款（还没有对应发票）。过账 Dr Bank / Cr 2300。
 * 抽成独立函数供 `POST /api/payments` 与测试共用，事务边界由调用方传入的
 * db（PrismaClient 或 $transaction 的 tx）决定。
 */
export async function recordPrepaymentReceived(
  db: DbClient,
  params: { customerId: string; amount: number; method?: string; paidAt?: Date; note?: string | null; actor: Actor },
) {
  const { customerId, amount, method = 'transfer', paidAt, note, actor } = params
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } })
  if (!customer) throw Object.assign(new Error('客户不存在'), { status: 404 })

  const payment = await db.payment.create({
    data: {
      customerId,
      amount,
      method,
      source: 'PREPAYMENT_RECEIVED',
      paidAt: paidAt ?? new Date(),
      note: note ?? null,
      createdBy: actor.name ?? actor.email,
    },
  })
  const journalEntry = await postPaymentToJournal(
    db,
    { id: payment.id, invoiceName: `Prepayment - ${customer.name}`, customerId, amount },
    actor.userId,
    { creditAccountCode: '2300', narration: `Prepayment received from ${customer.name}` },
  )
  return { payment, journalEntry }
}

/**
 * 用客户预付款余额冲抵一张发票。过账 Dr 2300 / Cr AR，不产生新现金流。
 * 事务内校验预付款余额充足 + 不超过发票剩余应付，通过 db 参数传入
 * `prisma.$transaction` 的 tx，保证校验与写入是同一个事务快照。
 */
export async function applyPrepaymentToInvoice(
  db: DbClient,
  params: { invoiceId: string; amount: number; actor: Actor },
) {
  const { invoiceId, amount, actor } = params
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } })
  if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
  if (!['POSTED', 'PAID'].includes(String(invoice.status))) {
    throw Object.assign(new Error('仅已确认(POSTED)的发票可用预付款冲抵'), { status: 400 })
  }

  const priorPayments = await db.payment.findMany({
    where: { customerId: invoice.customerId, source: { in: ['PREPAYMENT_RECEIVED', 'PREPAYMENT_APPLIED'] } },
    select: { source: true, amount: true },
  })
  const balanceBefore = computePrepaymentBalance(
    priorPayments.map((p: { source: string; amount: unknown }) => ({ source: p.source, amount: toNum(p.amount) })),
  )
  const amountDue = toNum(invoice.amountDue)

  try {
    validatePrepaymentApplication({ amount, availableBalance: balanceBefore, invoiceAmountDue: amountDue })
  } catch (e) {
    if (e instanceof PrepaymentValidationError) throw Object.assign(new Error(e.message), { status: 400 })
    throw e
  }

  const payment = await db.payment.create({
    data: {
      invoiceId,
      customerId: invoice.customerId,
      amount,
      method: 'other',
      source: 'PREPAYMENT_APPLIED',
      paidAt: new Date(),
      createdBy: actor.name ?? actor.email,
    },
  })

  const total = toNum(invoice.totalIncTax)
  const newPaid = round2(toNum(invoice.amountPaid) + amount)
  const newDue = round2(total - newPaid)
  const fullyPaid = newDue <= 0.005
  const invoiceAfter = await db.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid: newPaid,
      amountDue: Math.max(0, newDue),
      ...(fullyPaid ? { status: 'PAID', paidAt: new Date().toISOString() } : {}),
    },
  })

  const journalEntry = await postPrepaymentApplicationToJournal(
    db,
    { id: payment.id, invoiceName: invoice.name, customerId: invoice.customerId, amount },
    actor.userId,
  )

  return {
    payment,
    invoice: invoiceAfter,
    journalEntry,
    prepaymentBalanceAfter: round2(balanceBefore - amount),
  }
}
