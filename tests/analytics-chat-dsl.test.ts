import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDsl, validateDslSemantics, fillDefaults, type AnalysisDsl, type DslError } from '../lib/analytics-chat/dsl-schema'
import { DOMAIN_DEFS } from '../lib/analytics-chat/domains'

function ok(v: AnalysisDsl | DslError): AnalysisDsl {
  if ('message' in v) assert.fail(`expected valid DSL, got error: ${v.message}`)
  return v
}

function err(v: AnalysisDsl | DslError): DslError {
  if (!('message' in v)) assert.fail('expected DslError, got valid DSL')
  return v
}

test('parseDsl：最小合法输入（sales 域，只有 metric）', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'salesAmount' }))
  assert.equal(dsl.domain, 'sales')
  assert.equal(dsl.mode, 'aggregate')
  assert.equal(dsl.metric, 'salesAmount')
  assert.deepEqual(dsl.confirmedParams, {})
  assert.equal(dsl.dimension, null)
  assert.deepEqual(dsl.filters, {})
  assert.deepEqual(dsl.dateRange, {})
})

test('parseDsl：完整合法输入', () => {
  const dsl = ok(parseDsl({
    domain: 'sales',
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

test('parseDsl：非法 domain 拒绝', () => {
  const e = err(parseDsl({ domain: 'inventory', metric: 'salesAmount' }))
  assert.match(e.message, /domain/)
})

test('parseDsl：缺 domain 拒绝', () => {
  const e = err(parseDsl({ metric: 'salesAmount' }))
  assert.match(e.message, /domain/)
})

test('parseDsl：非法 metric 拒绝，不猜测/不降级', () => {
  const e = err(parseDsl({ domain: 'sales', metric: 'revenue' }))
  assert.match(e.message, /metric/)
})

test('parseDsl：跨域 metric 拒绝（quotationCount 不是 sales 域的指标）', () => {
  const e = err(parseDsl({ domain: 'sales', metric: 'quotationCount' }))
  assert.match(e.message, /metric/)
})

test('parseDsl：非法 dimension 拒绝', () => {
  const e = err(parseDsl({ domain: 'sales', metric: 'salesAmount', dimension: 'zipCode' }))
  assert.match(e.message, /dimension/)
})

test('parseDsl：跨域 dimension 格式校验通过但语义校验拒绝（product 不在 quotation 域白名单）', () => {
  const dsl = ok(parseDsl({ domain: 'quotation', metric: 'quotationCount', dimension: 'customer' }))
  assert.equal(validateDslSemantics(dsl), null)
  const e2 = err(parseDsl({ domain: 'quotation', metric: 'quotationCount', dimension: 'zipCode' }))
  assert.match(e2.message, /dimension/)
})

test('parseDsl：非白名单 filters 字段拒绝（防止 LLM 现造字段名）', () => {
  const e = err(parseDsl({ domain: 'sales', metric: 'salesAmount', filters: { productName: 'x' } }))
  assert.match(e.message, /filters/)
})

test('parseDsl：其它域不认识 sales 域的 filter key', () => {
  const e = err(parseDsl({ domain: 'delivery', mode: 'aggregate', metric: 'tripCount', filters: { customerId: 'c1' } }))
  assert.match(e.message, /filters/)
})

test('parseDsl：dateRange 格式不对拒绝', () => {
  const e = err(parseDsl({ domain: 'sales', metric: 'salesAmount', dateRange: { from: '2026/09/01' } }))
  assert.match(e.message, /dateRange/)
})

test('parseDsl：confirmedParams/filters/dateRange 显式给 null 时当"没提供"处理，不报错（Gemini nullable 字段实测会吐字面 null，不只是缺字段）', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'grossMargin', confirmedParams: null, filters: null, dateRange: null }))
  assert.deepEqual(dsl.confirmedParams, {})
  assert.deepEqual(dsl.filters, {})
  assert.deepEqual(dsl.dateRange, {})
})

test('parseDsl：非对象输入拒绝', () => {
  assert.ok('message' in parseDsl('本月销售额'))
  assert.ok('message' in parseDsl(null))
  assert.ok('message' in parseDsl([1, 2, 3]))
})

test('parseDsl：detail 模式缺日期范围拒绝（明细钻取的核心护栏）', () => {
  const e = err(parseDsl({ domain: 'sales', mode: 'detail' }))
  assert.match(e.message, /日期范围/)
})

test('parseDsl：detail 模式只给 from 不给 to 仍拒绝', () => {
  const e = err(parseDsl({ domain: 'sales', mode: 'detail', dateRange: { from: '2026-09-01' } }))
  assert.match(e.message, /日期范围/)
})

test('parseDsl：detail 模式带完整日期范围合法，metric/dimension 恒为 null', () => {
  const dsl = ok(parseDsl({
    domain: 'sales', mode: 'detail', metric: 'salesAmount', dimension: 'customer',
    dateRange: { from: '2026-09-01', to: '2026-09-06' },
  }))
  assert.equal(dsl.mode, 'detail')
  assert.equal(dsl.metric, null)
  assert.equal(dsl.dimension, null)
})

test('validateDslSemantics：grossMargin 不允许携带 taxBasis（锁死规则，不是可确认参数）', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'grossMargin', confirmedParams: { taxBasis: 'preTax' } }))
  const e = validateDslSemantics(dsl)
  assert.ok(e)
  assert.match(e!.message, /毛利/)
})

test('validateDslSemantics：salesAmount 携带 taxBasis 合法', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'salesAmount', confirmedParams: { taxBasis: 'preTax' } }))
  assert.equal(validateDslSemantics(dsl), null)
})

test('validateDslSemantics：sales 域维度必须在该指标 allowedDimensions 里（当前两个指标都是全量白名单，直接验证白名单本身完整）', () => {
  for (const key of Object.keys(DOMAIN_DEFS.sales.dimensions)) {
    const dsl = ok(parseDsl({ domain: 'sales', metric: 'grossMargin', dimension: key }))
    assert.equal(validateDslSemantics(dsl), null, `dimension ${key} 应该合法`)
  }
})

test('validateDslSemantics：四个域的每个指标至少能通过白名单自检（回归防呆）', () => {
  for (const domainDef of Object.values(DOMAIN_DEFS)) {
    for (const metricKey of Object.keys(domainDef.metrics)) {
      const dsl = ok(parseDsl({ domain: domainDef.key, metric: metricKey }))
      assert.equal(validateDslSemantics(dsl), null, `${domainDef.key}.${metricKey} 应该合法`)
    }
  }
})

test('fillDefaults：salesAmount 缺省 taxBasis 补 preTax', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'salesAmount' }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, 'preTax')
})

test('fillDefaults：grossMargin 不会凭空补出 taxBasis（它没有这个可确认参数）', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'grossMargin' }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, undefined)
})

test('fillDefaults：已显式指定的值不被默认值覆盖', () => {
  const dsl = ok(parseDsl({ domain: 'sales', metric: 'salesAmount', confirmedParams: { taxBasis: 'incTax' } }))
  const filled = fillDefaults(dsl)
  assert.equal(filled.confirmedParams.taxBasis, 'incTax')
})

test('fillDefaults：detail 模式原样返回，不补任何默认值', () => {
  const dsl = ok(parseDsl({ domain: 'sales', mode: 'detail', dateRange: { from: '2026-09-01', to: '2026-09-06' } }))
  const filled = fillDefaults(dsl)
  assert.deepEqual(filled, dsl)
})
