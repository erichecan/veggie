import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDsl, validateDslSemantics, fillDefaults, type AnalysisDsl, type DslError } from '../lib/analytics-chat/dsl-schema'
import { CHAT_DIMENSION_KEYS } from '../lib/analytics/semantic-model'

function ok(v: AnalysisDsl | DslError): AnalysisDsl {
  if ('message' in v) assert.fail(`expected valid DSL, got error: ${v.message}`)
  return v
}

function err(v: AnalysisDsl | DslError): DslError {
  if (!('message' in v)) assert.fail('expected DslError, got valid DSL')
  return v
}

test('parseDsl：最小合法输入（只有 metric）', () => {
  const dsl = ok(parseDsl({ metric: 'salesAmount' }))
  assert.equal(dsl.metric, 'salesAmount')
  assert.deepEqual(dsl.confirmedParams, {})
  assert.equal(dsl.dimension, null)
  assert.deepEqual(dsl.filters, {})
  assert.deepEqual(dsl.dateRange, {})
})

test('parseDsl：完整合法输入', () => {
  const dsl = ok(parseDsl({
    metric: 'salesAmount',
    confirmedParams: { taxBasis: 'incTax' },
    dimension: 'salesUser',
    filters: { customerId: 'c1' },
    dateRange: { from: '2026-09-01', to: '2026-09-06' },
  }))
  assert.equal(dsl.confirmedParams.taxBasis, 'incTax')
  assert.equal(dsl.dimension, 'salesUser')
  assert.equal(dsl.filters.customerId, 'c1')
  assert.deepEqual(dsl.dateRange, { from: '2026-09-01', to: '2026-09-06' })
})

test('parseDsl：非法 metric 拒绝，不猜测/不降级', () => {
  const e = err(parseDsl({ metric: 'revenue' }))
  assert.match(e.message, /metric/)
})

test('parseDsl：非法 dimension 拒绝', () => {
  const e = err(parseDsl({ metric: 'salesAmount', dimension: 'zipCode' }))
  assert.match(e.message, /dimension/)
})

test('parseDsl：非白名单 filters 字段拒绝（防止 LLM 现造字段名）', () => {
  const e = err(parseDsl({ metric: 'salesAmount', filters: { productName: 'x' } }))
  assert.match(e.message, /filters/)
})

test('parseDsl：dateRange 格式不对拒绝', () => {
  const e = err(parseDsl({ metric: 'salesAmount', dateRange: { from: '2026/09/01' } }))
  assert.match(e.message, /dateRange/)
})

test('parseDsl：非对象输入拒绝', () => {
  assert.ok('message' in parseDsl('本月销售额'))
  assert.ok('message' in parseDsl(null))
  assert.ok('message' in parseDsl([1, 2, 3]))
})

test('validateDslSemantics：grossMargin 不允许携带 taxBasis（锁死规则，不是可确认参数）', () => {
  const dsl = ok(parseDsl({ metric: 'grossMargin', confirmedParams: { taxBasis: 'preTax' } }))
  const e = validateDslSemantics(dsl)
  assert.ok(e)
  assert.match(e!.message, /毛利/)
})

test('validateDslSemantics：salesAmount 携带 taxBasis 合法', () => {
  const dsl = ok(parseDsl({ metric: 'salesAmount', confirmedParams: { taxBasis: 'preTax' } }))
  assert.equal(validateDslSemantics(dsl), null)
})

test('validateDslSemantics：维度必须在该指标 allowedDimensions 里（当前两个指标都是全量白名单，直接验证白名单本身完整）', () => {
  for (const key of CHAT_DIMENSION_KEYS) {
    const dsl = ok(parseDsl({ metric: 'grossMargin', dimension: key }))
    assert.equal(validateDslSemantics(dsl), null, `dimension ${key} 应该合法`)
  }
})

test('fillDefaults：salesAmount 缺省 taxBasis 补 preTax', () => {
  const dsl = ok(parseDsl({ metric: 'salesAmount' }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, 'preTax')
})

test('fillDefaults：grossMargin 不会凭空补出 taxBasis（它没有这个可确认参数）', () => {
  const dsl = ok(parseDsl({ metric: 'grossMargin' }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, undefined)
})

test('fillDefaults：已显式指定的值不被默认值覆盖', () => {
  const dsl = ok(parseDsl({ metric: 'salesAmount', confirmedParams: { taxBasis: 'incTax' } }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, 'incTax')
})
