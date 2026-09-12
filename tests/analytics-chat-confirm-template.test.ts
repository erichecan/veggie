import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderConfirmationText } from '../lib/analytics-chat/confirm-template'
import { fillDefaults, parseDsl } from '../lib/analytics-chat/dsl-schema'

function parsed(input: unknown) {
  const dsl = parseDsl(input)
  if ('message' in dsl) throw new Error(dsl.message)
  return fillDefaults(dsl)
}

test('renderConfirmationText：salesAmount 即使客户没提税前税后，也要把默认值列出来', () => {
  const dsl = parsed({ domain: 'sales', metric: 'salesAmount', dimension: 'salesUser' })
  const text = renderConfirmationText(dsl)
  assert.match(text, /税前\/税后口径：税前/)
  assert.match(text, /按业务员分组/)
  assert.match(text, /销售额/)
})

test('renderConfirmationText：grossMargin 不列任何税前/税后条目（它没有这个可确认参数）', () => {
  const dsl = parsed({ domain: 'sales', metric: 'grossMargin', dimension: 'product' })
  const text = renderConfirmationText(dsl)
  assert.doesNotMatch(text, /税前\/税后/)
  assert.match(text, /毛利/)
  assert.match(text, /按商品分组/)
})

test('renderConfirmationText：显式含税覆盖默认值', () => {
  const dsl = parsed({ domain: 'sales', metric: 'salesAmount', confirmedParams: { taxBasis: 'incTax' } })
  const text = renderConfirmationText(dsl)
  assert.match(text, /税后（含税）/)
})

test('renderConfirmationText：不分组时说"只要一个总计"', () => {
  const dsl = parsed({ domain: 'sales', metric: 'salesAmount' })
  const text = renderConfirmationText(dsl)
  assert.match(text, /不分组/)
})

test('renderConfirmationText：给了日期范围就原样展示，不用默认区间文案', () => {
  const dsl = parsed({ domain: 'sales', metric: 'salesAmount', dateRange: { from: '2026-09-01', to: '2026-09-06' } })
  const text = renderConfirmationText(dsl)
  assert.match(text, /2026-09-01 至 2026-09-06/)
})

test('renderConfirmationText：taxBasis=both 显式列出"都要"（20260912）', () => {
  const dsl = parsed({ domain: 'sales', metric: 'salesAmount', confirmedParams: { taxBasis: 'both' } })
  const text = renderConfirmationText(dsl)
  assert.match(text, /税前\+税后（都要）/)
})

test('renderConfirmationText：detail 模式说明含汇总小计，不再说"不做汇总"（20260912）', () => {
  const dsl = parsed({ domain: 'sales', mode: 'detail', dateRange: { from: '2026-09-01', to: '2026-09-06' } })
  const text = renderConfirmationText(dsl)
  assert.match(text, /汇总小计/)
  assert.doesNotMatch(text, /不做汇总/)
})
