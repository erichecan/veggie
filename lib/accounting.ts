/**
 * 会计过账引擎（简化版）
 * ============================================================================
 * 当发票从 DRAFT → POSTED 时自动生成日记账凭证：
 *
 *   Dr. Accounts Receivable (total_inc_tax)
 *       Cr. Sales Revenue       (subtotal_ex_tax)
 *       Cr. VAT Payable         (total_tax)
 *
 * 当 VendorBill 从 DRAFT → POSTED 时：
 *
 *   Dr. Purchase / COGS         (subtotal_ex_tax)
 *   Dr. VAT Receivable          (total_tax)
 *       Cr. Accounts Payable    (total_inc_tax)
 *
 * 所需的标准科目 code（必须预先在 Account 表存在，由 seed 导入）：
 *   1100 Accounts Receivable (RECEIVABLE)
 *   1110 VAT Receivable (ASSET)
 *   2100 Accounts Payable (PAYABLE)
 *   2200 VAT Payable (LIABILITY)
 *   4000 Sales Revenue (INCOME)
 *   5000 Purchases / COGS (EXPENSE)
 */

import type { PrismaClient } from './generated/prisma/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any

async function findAccountByCode(tx: TxClient, code: string): Promise<{ id: string } | null> {
  return tx.account.findUnique({ where: { code } })
}

async function genEntryName(tx: TxClient): Promise<string> {
  // 用最大序号+1 而非 count():count 在删除/与 seed 混用时会撞 @unique(name)。
  // 零填充使字符串降序排序等价于数值降序;并发下若仍撞,事务唯一约束失败由调用方重试。
  const last = await tx.journalEntry.findFirst({
    where: { name: { startsWith: 'JE-' } },
    orderBy: { name: 'desc' },
    select: { name: true },
  })
  const lastNum = last ? (parseInt(last.name.slice(3), 10) || 0) : 0
  return `JE-${String(lastNum + 1).padStart(5, '0')}`
}

/** 发票过账：Dr AR / Cr Revenue + VAT */
export async function postInvoiceToJournal(
  tx: TxClient,
  invoice: {
    id: string
    name: string
    customerId: string
    subtotalExTax: unknown
    totalTax: unknown
    totalIncTax: unknown
  },
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const ar = await findAccountByCode(tx, '1100')
  const rev = await findAccountByCode(tx, '4000')
  const vatOut = await findAccountByCode(tx, '2200')
  if (!ar || !rev || !vatOut) return null  // 科目未预置，静默跳过（seed 不全的环境）

  const sub = Number(invoice.subtotalExTax)
  const tax = Number(invoice.totalTax)
  const total = Number(invoice.totalIncTax)

  const name = await genEntryName(tx)
  const entry = await tx.journalEntry.create({
    data: {
      name,
      narration: `Invoice ${invoice.name} posted`,
      sourceType: 'invoice',
      sourceId: invoice.id,
      status: 'POSTED',
      totalDebit: total,
      totalCredit: total,
      createdBy: userId,
      postedAt: new Date(),
      lines: {
        create: [
          {
            accountId: ar.id,
            description: `AR - Invoice ${invoice.name}`,
            debit: total, credit: 0,
            partnerId: invoice.customerId,
            sequence: 10,
          },
          {
            accountId: rev.id,
            description: `Sales - Invoice ${invoice.name}`,
            debit: 0, credit: sub,
            sequence: 20,
          },
          ...(tax > 0 ? [{
            accountId: vatOut.id,
            description: `VAT Output - Invoice ${invoice.name}`,
            debit: 0, credit: tax,
            sequence: 30,
          }] : []),
        ],
      },
    },
    select: { id: true, name: true },
  })
  return entry
}

/** 供应商账单过账：Dr Purchase + VAT / Cr AP */
export async function postVendorBillToJournal(
  tx: TxClient,
  bill: {
    id: string
    name: string
    supplierId: string
    subtotalExTax: unknown
    totalTax: unknown
    totalIncTax: unknown
  },
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const ap = await findAccountByCode(tx, '2100')
  const purchase = await findAccountByCode(tx, '5000')
  const vatIn = await findAccountByCode(tx, '1110')
  if (!ap || !purchase || !vatIn) return null

  const sub = Number(bill.subtotalExTax)
  const tax = Number(bill.totalTax)
  const total = Number(bill.totalIncTax)

  const name = await genEntryName(tx)
  const entry = await tx.journalEntry.create({
    data: {
      name,
      narration: `Vendor Bill ${bill.name} posted`,
      sourceType: 'vendor_bill',
      sourceId: bill.id,
      status: 'POSTED',
      totalDebit: total,
      totalCredit: total,
      createdBy: userId,
      postedAt: new Date(),
      lines: {
        create: [
          {
            accountId: purchase.id,
            description: `Purchases - Bill ${bill.name}`,
            debit: sub, credit: 0,
            sequence: 10,
          },
          ...(tax > 0 ? [{
            accountId: vatIn.id,
            description: `VAT Input - Bill ${bill.name}`,
            debit: tax, credit: 0,
            sequence: 20,
          }] : []),
          {
            accountId: ap.id,
            description: `AP - Bill ${bill.name}`,
            debit: 0, credit: total,
            partnerId: bill.supplierId,
            sequence: 30,
          },
        ],
      },
    },
    select: { id: true, name: true },
  })
  return entry
}

/** 客户收款过账：Dr Bank / Cr AR（之前缺失,导致总账 AR 只增不减、永久虚高 — P1-6） */
export async function postPaymentToJournal(
  tx: TxClient,
  payment: { id: string; invoiceName: string; customerId: string; amount: unknown },
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const bank = await findAccountByCode(tx, '1200')
  const ar = await findAccountByCode(tx, '1100')
  if (!bank || !ar) return null
  const amt = Number(payment.amount)
  if (!(amt > 0)) return null

  const name = await genEntryName(tx)
  return tx.journalEntry.create({
    data: {
      name,
      narration: `Payment received for ${payment.invoiceName}`,
      sourceType: 'payment',
      sourceId: payment.id,
      status: 'POSTED',
      totalDebit: amt,
      totalCredit: amt,
      createdBy: userId,
      postedAt: new Date(),
      lines: {
        create: [
          { accountId: bank.id, description: `Bank - ${payment.invoiceName}`, debit: amt, credit: 0, sequence: 10 },
          { accountId: ar.id, description: `AR settle - ${payment.invoiceName}`, debit: 0, credit: amt, partnerId: payment.customerId, sequence: 20 },
        ],
      },
    },
    select: { id: true, name: true },
  })
}

/** 供应商付款过账：Dr AP / Cr Bank */
export async function postVendorPaymentToJournal(
  tx: TxClient,
  payment: { id: string; billName: string; supplierId: string; amount: unknown },
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const ap = await findAccountByCode(tx, '2100')
  const bank = await findAccountByCode(tx, '1200')
  if (!ap || !bank) return null
  const amt = Number(payment.amount)
  if (!(amt > 0)) return null

  const name = await genEntryName(tx)
  return tx.journalEntry.create({
    data: {
      name,
      narration: `Vendor payment for ${payment.billName}`,
      sourceType: 'vendor_payment',
      sourceId: payment.id,
      status: 'POSTED',
      totalDebit: amt,
      totalCredit: amt,
      createdBy: userId,
      postedAt: new Date(),
      lines: {
        create: [
          { accountId: ap.id, description: `AP settle - ${payment.billName}`, debit: amt, credit: 0, partnerId: payment.supplierId, sequence: 10 },
          { accountId: bank.id, description: `Bank - ${payment.billName}`, debit: 0, credit: amt, sequence: 20 },
        ],
      },
    },
    select: { id: true, name: true },
  })
}

/** 预置标准会计科目（seed 用） */
export const STANDARD_ACCOUNTS: Array<{ code: string; name: string; nameZh: string; type:
  'RECEIVABLE' | 'PAYABLE' | 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' | 'EQUITY'
  allowManual?: boolean
}> = [
  { code: '1100', name: 'Accounts Receivable', nameZh: '应收账款', type: 'RECEIVABLE' },
  { code: '1110', name: 'VAT Receivable',      nameZh: 'VAT 进项', type: 'ASSET' },
  { code: '1200', name: 'Bank',                nameZh: '银行',    type: 'ASSET', allowManual: true },
  { code: '2100', name: 'Accounts Payable',    nameZh: '应付账款', type: 'PAYABLE' },
  { code: '2200', name: 'VAT Payable',         nameZh: 'VAT 销项', type: 'LIABILITY' },
  { code: '3000', name: 'Retained Earnings',   nameZh: '未分配利润', type: 'EQUITY' },
  { code: '4000', name: 'Sales Revenue',       nameZh: '销售收入', type: 'INCOME' },
  { code: '5000', name: 'Purchases / COGS',    nameZh: '采购成本', type: 'EXPENSE' },
  { code: '6000', name: 'Operating Expenses',  nameZh: '运营费用', type: 'EXPENSE', allowManual: true },
]

// 保持 PrismaClient 类型引用以避免 tsc "unused import" 提示
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _keep = PrismaClient
