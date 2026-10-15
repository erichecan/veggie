import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { computeInvoiceBalance, nextInvoiceStatus } from '../lib/finance/invoice-balance'
import { computeVendorBillBalance } from '../lib/finance/vendor-bill-balance'
import { creditNoteRemaining } from '../lib/finance/credit-note-allocation'

/**
 * 复式改造（20261014）防回归：缓存余额只能由「唯一入账函数」写。
 * 任何文件在 update/upsert 的 data 里写这些字段、或对它们 increment/decrement，都直接失败——
 * 以前就是三处收款各自 `amountPaid + amount`，贷记单根本不碰发票，余额和明细各说各话。
 * 新建记录时置初值（create 里写 0 / 总额）不受限。
 */
const GUARDED: Record<string, string[]> = {
  amountPaid: ['lib/finance/invoice-balance.ts', 'lib/finance/vendor-bill-balance.ts'],
  amountDue: ['lib/finance/invoice-balance.ts', 'lib/finance/vendor-bill-balance.ts'],
  amountCredited: ['lib/finance/invoice-balance.ts'],
  // 库存（20261014 复式改造 L3）：只有 lib/stock-ledger.ts 能改在手量和批次余量
  qtyOnHand: ['lib/stock-ledger.ts'],
  currentQty: ['lib/stock-ledger.ts', 'lib/inventory.ts'],
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (f !== 'generated' && f !== 'node_modules') walk(p, out) }
    else if (/\.tsx?$/.test(f)) out.push(p)
  }
  return out
}

function offenders(field: string, allowed: string[]): string[] {
  const out: string[] = []
  // 窗口不跨过本次调用的结尾 `})`，否则会误抓到紧随其后的另一条 create 语句
  const updateData = new RegExp(String.raw`\.(update|updateMany|upsert)\(\{(?:(?!\}\))[\s\S]){0,300}?\b(data|update):\s*\{[^{}]*?\b${field}\s*:`, 'g')
  const incDec = new RegExp(String.raw`\b${field}\s*:\s*\{\s*(increment|decrement)`, 'g')
  // 先拼对象再传给 update/create 的写法（updateData.qtyOnHand = …，商品导入以前就是这么绕过流水的）
  const assign = new RegExp(String.raw`\b(updateData|createData|data)\.${field}\s*=(?!=)`, 'g')
  for (const file of [...walk('app'), ...walk('lib')]) {
    if (allowed.includes(file)) continue
    const src = readFileSync(file, 'utf8')
    const strictInit = field === 'qtyOnHand' && assign.test(src)
    if (updateData.test(src) || incDec.test(src) || strictInit) out.push(file)
    updateData.lastIndex = 0
    incDec.lastIndex = 0
    assign.lastIndex = 0
  }
  return out
}

for (const [field, allowed] of Object.entries(GUARDED)) {
  test(`只有唯一入账函数能改 ${field}`, () => {
    assert.deepEqual(offenders(field, allowed), [], `${field} 应改为写明细后调用 ${allowed.join(' / ')}`)
  })
}

test('库存流水只能经 postStockMove 写入；批次 FEFO 扣补只能由它调用', () => {
  const bad: string[] = []
  for (const file of [...walk('app'), ...walk('lib')]) {
    if (file === 'lib/stock-ledger.ts' || file === 'lib/inventory.ts') continue
    const src = readFileSync(file, 'utf8')
    if (/stockMove\.(create|createMany|update|updateMany|upsert)\(/.test(src)) bad.push(`${file}: stockMove 写入`)
    if (/\b(consumeLotsFIFO|restoreLotsFIFO)\(/.test(src)) bad.push(`${file}: 直接扣/补批次`)
  }
  assert.deepEqual(bad, [], '改为调用 lib/stock-ledger.ts 的 postStockMove（或订单用 lib/order-stock.ts 的 syncOrderStock）')
})

test('发票余额 = 总额 − 收款 − 贷记单抵扣', () => {
  const b = computeInvoiceBalance({ totalIncTax: 100, payments: [30, 20], creditAllocations: [10] })
  assert.deepEqual(b, { amountPaid: 50, amountCredited: 10, amountDue: 40, settled: false })
  const done = computeInvoiceBalance({ totalIncTax: 100, payments: [60], creditAllocations: [40] })
  assert.equal(done.amountDue, 0)
  assert.equal(done.settled, true)
  // 期初（Odoo 导入、无明细）的已收/已冲减计入，重算不会把历史发票打回未付
  const legacy = computeInvoiceBalance({ totalIncTax: 100, payments: [10], creditAllocations: [], openingPaid: 70, openingCredited: 5 })
  assert.deepEqual(legacy, { amountPaid: 80, amountCredited: 5, amountDue: 15, settled: false })
  // 冲正（负数抵扣）后余额回来
  const rev = computeInvoiceBalance({ totalIncTax: 100, payments: [60], creditAllocations: [40, -40] })
  assert.equal(rev.amountDue, 40)
  assert.equal(rev.settled, false)
})

test('发票状态只在 POSTED ⇄ PAID 之间按余额切换', () => {
  assert.equal(nextInvoiceStatus('POSTED', true), 'PAID')
  assert.equal(nextInvoiceStatus('PAID', false), 'POSTED')
  assert.equal(nextInvoiceStatus('PAID', true), 'PAID')
  assert.equal(nextInvoiceStatus('DRAFT', true), 'DRAFT')
  assert.equal(nextInvoiceStatus('CANCELLED', true), 'CANCELLED')
})

test('供应商账单余额 = 总额 − Σ 付款流水（含负数冲销）', () => {
  assert.deepEqual(computeVendorBillBalance(100, [60, 40]), { amountPaid: 100, amountDue: 0, settled: true })
  assert.deepEqual(computeVendorBillBalance(100, [60, 40, -40]), { amountPaid: 60, amountDue: 40, settled: false })
})

test('贷记单剩余 = 总额 − Σ 抵扣/退款', () => {
  assert.equal(creditNoteRemaining(50, [20, 10]), 20)
  assert.equal(creditNoteRemaining(50, [20, -20]), 50)
})
