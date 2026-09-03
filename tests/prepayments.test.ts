/**
 * 客户预付款 —— 余额计算 / 冲抵校验（纯函数）+ 端到端记账方向验证
 *
 * 端到端部分是本次任务里最不能出错的一条：直接查 JournalEntryLine 断言
 * 借贷方向，而不是只看接口返回值 —— 接口返回值对不代表分录方向对。
 * 没有 DATABASE_URL 时跳过，与 tests/generate-statements-cron.test.ts 同一约定。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { computePrepaymentBalance, validatePrepaymentApplication, PrepaymentValidationError } from '../lib/prepayments'

import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
// 见 generate-statements-cron.test.ts 同一条注释：动态 import 确保严格晚于 config()，
// 避免 lib/db 单例用尚未注入的空 DATABASE_URL 建连接。
let recordPrepaymentReceived: typeof import('../lib/prepayments')['recordPrepaymentReceived']
let applyPrepaymentToInvoice: typeof import('../lib/prepayments')['applyPrepaymentToInvoice']

neonConfig.webSocketConstructor = ws

const DB_URL = process.env.DATABASE_URL
const NO_DB = !DB_URL && '未设置 DATABASE_URL：此文件需要真实数据库，本地跑 `npm test` 时才会执行'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: DB_URL ?? 'postgresql://unused' }) })

let testCustomerId = ''
let testInvoiceId = ''
let testInvoiceId2 = ''
const createdPaymentIds: string[] = []
const createdJournalEntryIds: string[] = []

before(async () => {
  const mod = await import('../lib/prepayments')
  recordPrepaymentReceived = mod.recordPrepaymentReceived
  applyPrepaymentToInvoice = mod.applyPrepaymentToInvoice

  if (NO_DB) return
  const customer = await prisma.customer.create({ data: { name: '__test_prepayments__' } })
  testCustomerId = customer.id
  const invoice = await prisma.invoice.create({
    data: {
      name: `__TEST-PREPAY-${Date.now()}__`,
      customerId: customer.id,
      customerName: customer.name,
      totalIncTax: 100,
      amountPaid: 0,
      amountDue: 100,
      status: 'POSTED',
    },
  })
  testInvoiceId = invoice.id
  // 第二张发票，剩余应付故意开得很大，专门用来测"超过预付款余额"这条拒绝路径——
  // 跟第一张分开，不依赖测试执行顺序/第一张发票冲抵后的状态。
  const invoice2 = await prisma.invoice.create({
    data: {
      name: `__TEST-PREPAY-2-${Date.now()}__`,
      customerId: customer.id,
      customerName: customer.name,
      totalIncTax: 99999,
      amountPaid: 0,
      amountDue: 99999,
      status: 'POSTED',
    },
  })
  testInvoiceId2 = invoice2.id
})

after(async () => {
  if (NO_DB) return
  if (createdJournalEntryIds.length) {
    await prisma.journalEntryLine.deleteMany({ where: { entryId: { in: createdJournalEntryIds } } })
    await prisma.journalEntry.deleteMany({ where: { id: { in: createdJournalEntryIds } } })
  }
  if (createdPaymentIds.length) {
    await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } })
  }
  if (testInvoiceId) await prisma.invoice.delete({ where: { id: testInvoiceId } })
  if (testInvoiceId2) await prisma.invoice.delete({ where: { id: testInvoiceId2 } })
  if (testCustomerId) await prisma.customer.delete({ where: { id: testCustomerId } })
  await prisma.$disconnect()
})

// ── 纯函数：余额计算 ──────────────────────────────────────────────────────
test('余额计算：只有 RECEIVED', () => {
  const balance = computePrepaymentBalance([{ source: 'PREPAYMENT_RECEIVED', amount: 200 }])
  assert.equal(balance, 200)
})

test('余额计算：RECEIVED 减去 APPLIED', () => {
  const balance = computePrepaymentBalance([
    { source: 'PREPAYMENT_RECEIVED', amount: 200 },
    { source: 'PREPAYMENT_APPLIED', amount: 80 },
  ])
  assert.equal(balance, 120)
})

test('余额计算：CASH 不参与计算', () => {
  const balance = computePrepaymentBalance([
    { source: 'PREPAYMENT_RECEIVED', amount: 100 },
    { source: 'CASH', amount: 9999 },
  ])
  assert.equal(balance, 100)
})

test('余额计算：全部冲完后为 0', () => {
  const balance = computePrepaymentBalance([
    { source: 'PREPAYMENT_RECEIVED', amount: 50 },
    { source: 'PREPAYMENT_APPLIED', amount: 50 },
  ])
  assert.equal(balance, 0)
})

// ── 纯函数：冲抵校验 ──────────────────────────────────────────────────────
test('冲抵校验：金额必须 >0', () => {
  assert.throws(
    () => validatePrepaymentApplication({ amount: 0, availableBalance: 100, invoiceAmountDue: 100 }),
    PrepaymentValidationError,
  )
})

test('冲抵校验：超过预付款余额拒绝', () => {
  assert.throws(
    () => validatePrepaymentApplication({ amount: 150, availableBalance: 100, invoiceAmountDue: 200 }),
    PrepaymentValidationError,
  )
})

test('冲抵校验：超过发票剩余应付拒绝', () => {
  assert.throws(
    () => validatePrepaymentApplication({ amount: 150, availableBalance: 200, invoiceAmountDue: 100 }),
    PrepaymentValidationError,
  )
})

test('冲抵校验：正常冲抵通过（不抛错）', () => {
  assert.doesNotThrow(() =>
    validatePrepaymentApplication({ amount: 80, availableBalance: 100, invoiceAmountDue: 100 }),
  )
})

// ── 端到端：记一笔预收款 → 查余额 → 冲抵发票 → 再查余额 → 分录方向 ──────
test('端到端：预收款登记 + 冲抵发票，分录借贷方向正确', { skip: !!NO_DB }, async () => {
  const actor = { userId: 'test-user', name: 'Test User', email: null }

  // 1. 收到预收款 €150（发票总额只有 €100，故意多收，模拟真实场景客户先多打钱）
  const received = await prisma.$transaction(tx =>
    recordPrepaymentReceived(tx, { customerId: testCustomerId, amount: 150, actor }),
  )
  createdPaymentIds.push(received.payment.id)
  assert.ok(received.journalEntry, '预收款过账必须成功生成凭证（说明 1200/2300 科目都在）')
  createdJournalEntryIds.push(received.journalEntry!.id)

  // 分录方向：Dr Bank(1200) / Cr 2300
  const receivedLines = await prisma.journalEntryLine.findMany({
    where: { entryId: received.journalEntry!.id },
    include: { account: { select: { code: true } } },
  })
  const bankLine = receivedLines.find(l => l.account.code === '1200')
  const prepayLine = receivedLines.find(l => l.account.code === '2300')
  assert.ok(bankLine && Number(bankLine.debit) === 150 && Number(bankLine.credit) === 0, 'Bank 应该是借方 150')
  assert.ok(prepayLine && Number(prepayLine.credit) === 150 && Number(prepayLine.debit) === 0, '2300 应该是贷方 150')

  // 2. 查余额 = 150
  const balanceAfterReceive = computePrepaymentBalance(
    (await prisma.payment.findMany({
      where: { customerId: testCustomerId, source: { in: ['PREPAYMENT_RECEIVED', 'PREPAYMENT_APPLIED'] } },
      select: { source: true, amount: true },
    })).map(p => ({ source: p.source, amount: Number(p.amount) })),
  )
  assert.equal(balanceAfterReceive, 150)

  // 3. 用 €100 冲抵发票（发票总额刚好 €100）
  const applied = await prisma.$transaction(tx =>
    applyPrepaymentToInvoice(tx, { invoiceId: testInvoiceId, amount: 100, actor }),
  )
  createdPaymentIds.push(applied.payment.id)
  assert.ok(applied.journalEntry)
  createdJournalEntryIds.push(applied.journalEntry!.id)
  assert.equal(applied.prepaymentBalanceAfter, 50, '冲抵后预付款余额应该剩 50（150-100）')
  assert.equal(Number(applied.invoice.amountDue), 0, '发票应付余额应该清零')
  assert.equal(applied.invoice.status, 'PAID', '发票应付清零后应自动转 PAID')

  // 分录方向：Dr 2300 / Cr AR(1100) —— 跟"收到预收款"方向相反，且不动 Bank
  const appliedLines = await prisma.journalEntryLine.findMany({
    where: { entryId: applied.journalEntry!.id },
    include: { account: { select: { code: true } } },
  })
  const prepayDebitLine = appliedLines.find(l => l.account.code === '2300')
  const arLine = appliedLines.find(l => l.account.code === '1100')
  const bankTouched = appliedLines.some(l => l.account.code === '1200')
  assert.ok(prepayDebitLine && Number(prepayDebitLine.debit) === 100 && Number(prepayDebitLine.credit) === 0, '2300 应该是借方 100')
  assert.ok(arLine && Number(arLine.credit) === 100 && Number(arLine.debit) === 0, 'AR 应该是贷方 100')
  assert.equal(bankTouched, false, '冲抵预付款不产生新现金流，Bank 科目不应该出现在这张凭证里')

  // 4. 再查余额 = 50
  const balanceAfterApply = computePrepaymentBalance(
    (await prisma.payment.findMany({
      where: { customerId: testCustomerId, source: { in: ['PREPAYMENT_RECEIVED', 'PREPAYMENT_APPLIED'] } },
      select: { source: true, amount: true },
    })).map(p => ({ source: p.source, amount: Number(p.amount) })),
  )
  assert.equal(balanceAfterApply, 50)

  // 5. 剩余余额只有 50，尝试冲抵第二张发票 200 → 必须拒绝（超过预付款余额，
  //    不是超过发票应付——第二张发票应付高达 99999，不会先撞到那条限制）
  await assert.rejects(
    () => prisma.$transaction(tx => applyPrepaymentToInvoice(tx, { invoiceId: testInvoiceId2, amount: 200, actor })),
    (err: unknown) => {
      const e = err as { status?: number; message?: string }
      return e.status === 400 && !!e.message?.includes('预付款余额')
    },
  )

  // 6. 上一步失败的事务必须完全回滚，余额还是 50，不能因为失败调用而扣掉
  const balanceAfterRejectedApply = computePrepaymentBalance(
    (await prisma.payment.findMany({
      where: { customerId: testCustomerId, source: { in: ['PREPAYMENT_RECEIVED', 'PREPAYMENT_APPLIED'] } },
      select: { source: true, amount: true },
    })).map(p => ({ source: p.source, amount: Number(p.amount) })),
  )
  assert.equal(balanceAfterRejectedApply, 50, '被拒绝的冲抵不能改变余额（事务必须回滚）')
})
