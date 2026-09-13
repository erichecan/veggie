import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOMAIN_DEFS, COMPILER_ROW_LIMIT } from '../lib/analytics-chat/domains'
import { domainCatalogText } from '../lib/analytics-chat/llm'

test('COMPILER_ROW_LIMIT：20260912 客户反馈 500 太小，改成 1000', () => {
  assert.equal(COMPILER_ROW_LIMIT, 1000)
})

/**
 * 20260912：两个客户反馈的回归测试——
 *   1. taxBasis 不能被迫二选一，问"税前税后都要"要能同时拿到两个数字
 *   2. 明细（逐行）查询也要给一个汇总小计，不能只有裸行
 * 这里只测"域定义/SQL 拼装"这一层的纯函数部分，不碰数据库
 * （真正执行结果的求和逻辑在 compiler.ts，需要真实 DB，交给手工验证 + 生产回归）。
 */

test('sales 域 salesAmount：taxBasis=both 时 SQL 多吐一列 value2（税后），且 secondaryValueLabel 给出中文名', () => {
  const metric = DOMAIN_DEFS.sales.metrics.salesAmount
  assert.ok(metric.secondaryValueLabel, 'salesAmount 必须声明 secondaryValueLabel')
  assert.equal(metric.secondaryValueLabel!({ taxBasis: 'both' }), '税后（含税）')
  assert.equal(metric.secondaryValueLabel!({ taxBasis: 'preTax' }), null)
  assert.equal(metric.secondaryValueLabel!({}), null)

  const { sql } = DOMAIN_DEFS.sales.buildAggregateSql({
    metric, confirmedParams: { taxBasis: 'both' }, dimension: null, filters: {},
    start: new Date('2026-09-01'), end: new Date('2026-09-02'), rowLimit: 500,
  })
  assert.match(sql, /AS value2/)
})

test('sales 域 salesAmount：taxBasis=preTax/incTax（非 both）时 SQL 不带 value2 列', () => {
  const metric = DOMAIN_DEFS.sales.metrics.salesAmount
  for (const taxBasis of ['preTax', 'incTax']) {
    const { sql } = DOMAIN_DEFS.sales.buildAggregateSql({
      metric, confirmedParams: { taxBasis }, dimension: null, filters: {},
      start: new Date('2026-09-01'), end: new Date('2026-09-02'), rowLimit: 500,
    })
    assert.doesNotMatch(sql, /AS value2/, `taxBasis=${taxBasis} 不应该带 value2`)
  }
})

test('sales 域 grossMargin：没有 secondaryValueLabel，不受 both 逻辑影响', () => {
  const metric = DOMAIN_DEFS.sales.metrics.grossMargin
  assert.equal(metric.secondaryValueLabel, undefined)
})

test('四个域的明细模式：金额/数量字段都标了 summable，供 compiler 算汇总小计', () => {
  const expectSummable: Record<string, string[]> = {
    sales: ['qty', 'subtotal'],
    quotation: ['amount'],
    procurement: ['ordered_qty', 'received_qty', 'subtotal'],
    delivery: ['qty', 'subtotal'],
  }
  for (const [domainKey, keys] of Object.entries(expectSummable)) {
    const fields = DOMAIN_DEFS[domainKey as keyof typeof DOMAIN_DEFS].detail!.fields
    const summableKeys = fields.filter((f) => f.summable).map((f) => f.key)
    assert.deepEqual(summableKeys.sort(), keys.sort(), `${domainKey} 域 summable 字段应为 ${keys.join('/')}`)
  }
})

test('domainCatalogText：喂给 Gemini 的每个域明细字段列表必须来自真实 detail.fields，不是写死的占位文案（20260913）', () => {
  const text = domainCatalogText()
  for (const domainDef of Object.values(DOMAIN_DEFS)) {
    if (!domainDef.detail) continue
    for (const field of domainDef.detail.fields) {
      assert.ok(text.includes(field.labelZh), `${domainDef.key} 域说明里应该出现真实字段"${field.labelZh}"`)
    }
  }
})

test('sales 域明细：补上业务员列（此前"改问明细"的引导建议曾承诺过这一列但实际没有）', () => {
  const fields = DOMAIN_DEFS.sales.detail!.fields.map((f) => f.key)
  assert.ok(fields.includes('sales_user_name'), 'sales 域明细应包含 sales_user_name')
  const { sql } = DOMAIN_DEFS.sales.detail!.buildSql({
    filters: {}, start: new Date('2026-09-01'), end: new Date('2026-09-02'), rowLimit: 500,
  })
  assert.match(sql, /AS sales_user_name/)
})

test('delivery 域明细：新增 subtotal 列 = unit_price * qty（此前完全没有金额汇总）', () => {
  const { sql } = DOMAIN_DEFS.delivery.detail!.buildSql({
    filters: {}, start: new Date('2026-09-01'), end: new Date('2026-09-02'), rowLimit: 500,
  })
  assert.match(sql, /AS subtotal/)
})
