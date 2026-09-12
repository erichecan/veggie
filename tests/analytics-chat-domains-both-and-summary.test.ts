import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOMAIN_DEFS } from '../lib/analytics-chat/domains'

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

test('delivery 域明细：新增 subtotal 列 = unit_price * qty（此前完全没有金额汇总）', () => {
  const { sql } = DOMAIN_DEFS.delivery.detail!.buildSql({
    filters: {}, start: new Date('2026-09-01'), end: new Date('2026-09-02'), rowLimit: 500,
  })
  assert.match(sql, /AS subtotal/)
})
