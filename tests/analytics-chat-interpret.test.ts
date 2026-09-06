import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretToDsl } from '../lib/analytics-chat/interpret'
import type { InterpretOutcome } from '../lib/analytics-chat/llm'

function fakeInterpreter(...outcomes: InterpretOutcome[]) {
  let i = 0
  return async () => outcomes[Math.min(i++, outcomes.length - 1)]
}

test('interpretToDsl：一次就理解成功', async () => {
  const fake = fakeInterpreter({ raw: { understood: true, dsl: { metric: 'salesAmount' } } })
  const result = await interpretToDsl('本月销售额', null, fake as never)
  assert.equal(result.status, 'confirm')
  if (result.status === 'confirm') {
    assert.equal(result.dsl.metric, 'salesAmount')
    assert.equal(result.dsl.confirmedParams.taxBasis, 'preTax')
  }
})

test('interpretToDsl：understood=false 直接返回 unsupported，不重试', async () => {
  let calls = 0
  const fake = async () => { calls++; return { raw: { understood: false, unsupportedReason: '不支持这个维度' } } }
  const result = await interpretToDsl('按邮编统计', null, fake as never)
  assert.equal(result.status, 'unsupported')
  if (result.status === 'unsupported') assert.equal(result.reason, '不支持这个维度')
  assert.equal(calls, 1)
})

test('interpretToDsl：第一次格式错误，第二次修正成功', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { metric: 'not-a-metric' } } },
    { raw: { understood: true, dsl: { metric: 'grossMargin' } } },
  )
  const result = await interpretToDsl('毛利', null, fake as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：第一次语义错误（grossMargin 带 taxBasis），重试后修正', async () => {
  const fake = fakeInterpreter(
    { raw: { understood: true, dsl: { metric: 'grossMargin', confirmedParams: { taxBasis: 'preTax' } } } },
    { raw: { understood: true, dsl: { metric: 'grossMargin' } } },
  )
  const result = await interpretToDsl('毛利，税前的', null, fake as never)
  assert.equal(result.status, 'confirm')
})

test('interpretToDsl：连续 3 次都错，返回 error 而不是硬跑一个近似查询', async () => {
  let calls = 0
  const fake = async () => { calls++; return { raw: { understood: true, dsl: { metric: 'not-a-metric' } } } }
  const result = await interpretToDsl('随便问点什么', null, fake as never)
  assert.equal(result.status, 'error')
  assert.equal(calls, 3) // 首次 + 最多 2 次重试
})

test('interpretToDsl：unavailable（没配 API key）直接返回 error，不重试', async () => {
  let calls = 0
  const fake = async () => { calls++; return { unavailable: true, reason: '未配置 GEMINI_API_KEY' } }
  const result = await interpretToDsl('本月销售额', null, fake as never)
  assert.equal(result.status, 'error')
  assert.equal(calls, 1)
})
