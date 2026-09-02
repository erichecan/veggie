import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeIncomeStatement } from '../lib/analytics/income-statement'

test('空区间 → 全零，不除以零', () => {
  const result = computeIncomeStatement([])
  assert.deepEqual(result, { revenue: 0, cogs: 0, grossMargin: 0, grossMarginPct: 0 })
})

test('只有 INCOME 没有 EXPENSE：营收全额算毛利，毛利率 100%', () => {
  const result = computeIncomeStatement([
    { accountType: 'INCOME', debit: 0, credit: 1000 },
  ])
  assert.deepEqual(result, { revenue: 1000, cogs: 0, grossMargin: 1000, grossMarginPct: 100 })
})

test('营收与 COGS 都有：毛利 = 营收 - COGS，毛利率按营收算', () => {
  const result = computeIncomeStatement([
    { accountType: 'INCOME', debit: 0, credit: 1000 },
    { accountType: 'EXPENSE', debit: 600, credit: 0 },
  ])
  assert.deepEqual(result, { revenue: 1000, cogs: 600, grossMargin: 400, grossMarginPct: 40 })
})

test('多行同类型科目会先求和：INCOME 按 credit-debit 累加，EXPENSE 按 debit-credit 累加', () => {
  const result = computeIncomeStatement([
    { accountType: 'INCOME', debit: 0, credit: 700 },
    { accountType: 'INCOME', debit: 0, credit: 300 },
    { accountType: 'EXPENSE', debit: 400, credit: 0 },
    { accountType: 'EXPENSE', debit: 200, credit: 0 },
  ])
  assert.deepEqual(result, { revenue: 1000, cogs: 600, grossMargin: 400, grossMarginPct: 40 })
})

test('COGS 超过营收：毛利为负，不做特殊处理直接算出负数', () => {
  const result = computeIncomeStatement([
    { accountType: 'INCOME', debit: 0, credit: 500 },
    { accountType: 'EXPENSE', debit: 800, credit: 0 },
  ])
  assert.deepEqual(result, { revenue: 500, cogs: 800, grossMargin: -300, grossMarginPct: -60 })
})

test('营收为 0 时毛利率不除以零，返回 0', () => {
  const result = computeIncomeStatement([
    { accountType: 'EXPENSE', debit: 200, credit: 0 },
  ])
  assert.deepEqual(result, { revenue: 0, cogs: 200, grossMargin: -200, grossMarginPct: 0 })
})

test('冲销/贷项分录（credit 大于 debit 的 EXPENSE，或 debit 大于 credit 的 INCOME）会正确抵减', () => {
  // 一笔 INCOME 分录反向冲销（比如信用票据的红字冲销），credit 小、debit 大，营收应被抵减
  const result = computeIncomeStatement([
    { accountType: 'INCOME', debit: 0, credit: 1000 },
    { accountType: 'INCOME', debit: 200, credit: 0 }, // 冲销 200
  ])
  assert.deepEqual(result, { revenue: 800, cogs: 0, grossMargin: 800, grossMarginPct: 100 })
})
