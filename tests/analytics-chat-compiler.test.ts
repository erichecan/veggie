import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weightedAverage } from '../lib/analytics-chat/compiler'

test('weightedAverage：按 qty 加权，不是简单相加（20260910 实测发现分组转化率求和吐出 737.82% 的假数字）', () => {
  // 100 个样本 90% 转化 + 10 个样本 50% 转化 → 加权平均应接近 90%，不是 (90+50)=140
  const avg = weightedAverage([{ value: 90, qty: 100 }, { value: 50, qty: 10 }])
  assert.ok(Math.abs(avg - (100 * 90 + 10 * 50) / 110) < 1e-9)
  assert.ok(avg < 100, 'rate 类指标总计不能超过单组最大值太多，更不能破百分比上限')
})

test('weightedAverage：全部 qty=0 时返回 0，不除零', () => {
  assert.equal(weightedAverage([{ value: 90, qty: 0 }, { value: 50, qty: 0 }]), 0)
})

test('weightedAverage：单组直接等于该组的值', () => {
  assert.equal(weightedAverage([{ value: 97.8, qty: 545 }]), 97.8)
})
