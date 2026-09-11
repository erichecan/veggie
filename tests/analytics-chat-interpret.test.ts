import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretToDsl } from '../lib/analytics-chat/interpret'
import type { InterpretOutcome } from '../lib/analytics-chat/llm'

function fakeInterpreter(...outcomes: InterpretOutcome[]) {
  let i = 0
  return async () => outcomes[Math.min(i++, outcomes.length - 1)]
}

/** 默认"无歧义"的探测假实现——大多数测试不关心歧义分支，用它保持离线可跑 */
const noAmbiguity = async () => ({ raw: { alternativeDomain: null } })

test('interpretToDsl：一次就理解成功', async () => {
  const fake = fakeInterpreter({ raw: { understood: true, dsl: { domain: 'sales', metric: 'salesAmount' } } })
  const result = await interpretToDsl('本月销售额', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'confirm')
  if (result.status === 'confirm') {
    assert.equal(result.dsl.metric, 'salesAmount')
    assert.equal(result.dsl.confirmedParams.taxBasis, 'preTax')
  }
})

test('interpretToDsl：understood=false 直接返回 unsupported，不重试', async () => {
  let calls = 0
  const fake = async () => { calls++; return { raw: { understood: false, unsupportedReason: '不支持这个维度' } } }
  const result = await interpretToDsl('按邮编统计', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'unsupported')
  if (result.status === 'unsupported') assert.equal(result.reason, '不支持这个维度')
  assert.equal(calls, 1)
})

test('interpretToDsl：第一次格式错误，第二次修正成功', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { domain: 'sales', metric: 'not-a-metric' } } },
    { raw: { understood: true, dsl: { domain: 'sales', metric: 'grossMargin' } } },
  )
  const result = await interpretToDsl('毛利', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：第一次语义错误（grossMargin 带 taxBasis），重试后修正', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { domain: 'sales', metric: 'grossMargin', confirmedParams: { taxBasis: 'preTax' } } } },
    { raw: { understood: true, dsl: { domain: 'sales', metric: 'grossMargin' } } },
  )
  const result = await interpretToDsl('毛利，税前的', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：连续 3 次都错，返回 error 而不是硬跑一个近似查询', async () => {
  let calls = 0
  const fake = async () => { calls++; return { raw: { understood: true, dsl: { domain: 'sales', metric: 'not-a-metric' } } } }
  const result = await interpretToDsl('随便问点什么', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'error')
  assert.equal(calls, 3) // 首次 + 最多 2 次重试
})

test('interpretToDsl：unavailable（没配 API key）直接返回 error，不重试', async () => {
  let calls = 0
  const fake = async () => { calls++; return { unavailable: true, reason: '未配置 GEMINI_API_KEY' } }
  const result = await interpretToDsl('本月销售额', null, fake as never, noAmbiguity as never)
  assert.equal(result.status, 'error')
  assert.equal(calls, 1)
})

test('interpretToDsl：有 priorDsl（多轮追问）不做歧义探测', async () => {
  let ambiguityCalls = 0
  const fake = fakeInterpreter({ raw: { understood: true, dsl: { domain: 'sales', metric: 'grossMargin', dimension: 'customer' } } })
  const fakeAmbiguity = async () => { ambiguityCalls++; return { raw: { alternativeDomain: 'delivery' } } }
  const prior = { domain: 'sales' as const, mode: 'aggregate' as const, metric: 'salesAmount', confirmedParams: {}, dimension: null, filters: {}, dateRange: {} }
  const result = await interpretToDsl('那按客户看毛利', prior, fake as never, fakeAmbiguity as never)
  assert.equal(result.status, 'confirm')
  assert.equal(ambiguityCalls, 0, '追问场景不应该触发歧义探测调用')
})

test('interpretToDsl：探测出不同域且第二候选校验通过 → 返回 ambiguous 带两个候选', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { domain: 'sales', mode: 'detail', dateRange: { from: '2026-07-03', to: '2026-07-03' } } } },
    { raw: { understood: true, dsl: { domain: 'delivery', mode: 'detail', dateRange: { from: '2026-07-03', to: '2026-07-03' } } } },
  )
  const fakeAmbiguity = async () => ({ raw: { alternativeDomain: 'delivery' } })
  const result = await interpretToDsl('客户订单送了什么货', null, fake as never, fakeAmbiguity as never)
  assert.equal(result.status, 'ambiguous')
  if (result.status === 'ambiguous') {
    assert.equal(result.candidates.length, 2)
    assert.equal(result.candidates[0]!.domain, 'sales')
    assert.equal(result.candidates[1]!.domain, 'delivery')
  }
})

test('interpretToDsl：探测调用本身失败（网络错误）→ 静默退化成正常 confirm', async () => {
  const fake = fakeInterpreter({ raw: { understood: true, dsl: { domain: 'sales', metric: 'salesAmount' } } })
  const fakeAmbiguity = async () => ({ failed: true, reason: '网络错误' })
  const result = await interpretToDsl('本月销售额', null, fake as never, fakeAmbiguity as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：探测出的候选域重新抽取时校验不过 → 退化成正常 confirm', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { domain: 'sales', metric: 'salesAmount' } } },
    { raw: { understood: true, dsl: { domain: 'delivery', metric: 'not-a-real-metric' } } }, // 非法
  )
  const fakeAmbiguity = async () => ({ raw: { alternativeDomain: 'delivery' } })
  const result = await interpretToDsl('本月销售额', null, fake as never, fakeAmbiguity as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：探测出的候选域跟主候选相同（模型没给出真正不同的域）→ 退化成正常 confirm', async () => {
  const fake = fakeInterpreter({ raw: { understood: true, dsl: { domain: 'sales', metric: 'salesAmount' } } })
  const fakeAmbiguity = async () => ({ raw: { alternativeDomain: 'sales' } })
  const result = await interpretToDsl('本月销售额', null, fake as never, fakeAmbiguity as never)
  assert.equal(result.status, 'confirm')
})
