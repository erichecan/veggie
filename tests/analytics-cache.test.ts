/**
 * 分析响应缓存的行为约束。
 *
 * 这层东西一旦出错的表现是「数字不对但没人报错」，比崩溃更难查，所以把
 * key 构造、TTL 选择、淘汰、体积上限这几条都锁住。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheKey, getCached, setCached, clearAnalyticsCache, ttlFor, getStats, __resetStats,
} from '../lib/analytics/cache'

beforeEach(() => { clearAnalyticsCache(); __resetStats() })

describe('cacheKey', () => {
  test('参数顺序不同但内容相同 → 同一个 key（否则命中率白白流失）', () => {
    const a = cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-01&to=2026-07-31'), ['BOSS'])
    const b = cacheKey('/api/analytics/margin', new URLSearchParams('to=2026-07-31&from=2026-07-01'), ['BOSS'])
    assert.equal(a, b)
  })

  test('任一参数不同 → 不同 key', () => {
    const base = cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-01'), ['BOSS'])
    assert.notEqual(base, cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-02'), ['BOSS']))
    assert.notEqual(base, cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-01&groupBy=customer'), ['BOSS']))
    assert.notEqual(base, cacheKey('/api/analytics/customers', new URLSearchParams('from=2026-07-01'), ['BOSS']))
  })

  test('⛔ 角色不同 → 不同 key（防将来加了行级过滤而缓存串数据）', () => {
    const boss  = cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-01'), ['BOSS'])
    const sales = cacheKey('/api/analytics/margin', new URLSearchParams('from=2026-07-01'), ['SALES'])
    assert.notEqual(boss, sales)
  })

  test('角色顺序不影响 key', () => {
    const a = cacheKey('/api/x', new URLSearchParams(), ['BOSS', 'SALES'])
    const b = cacheKey('/api/x', new URLSearchParams(), ['SALES', 'BOSS'])
    assert.equal(a, b)
  })
})

describe('存取与过期', () => {
  test('存了能取到', () => {
    setCached('k1', '{"a":1}', 60_000)
    assert.equal(getCached('k1'), '{"a":1}')
    assert.equal(getStats().hits, 1)
  })

  test('未命中返回 null 并计数', () => {
    assert.equal(getCached('nope'), null)
    assert.equal(getStats().misses, 1)
  })

  test('TTL 到期后取不到，且条目被清掉', () => {
    setCached('k2', 'x', -1)   // 已过期
    assert.equal(getCached('k2'), null)
    assert.equal(getStats().size, 0)
  })
})

describe('TTL 选择', () => {
  test('区间覆盖到今天 → 短 TTL（数据还在变）', () => {
    const future = new Date(Date.now() + 3600_000)
    assert.equal(ttlFor(future), 60_000)
  })

  test('纯历史区间 → 长 TTL', () => {
    const past = new Date(Date.now() - 86400_000)
    assert.equal(ttlFor(past), 15 * 60_000)
  })
})

describe('内存保护', () => {
  test('⛔ 超大响应不缓存 —— 缓存不该变成新的 OOM 来源', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1)
    setCached('big', huge, 60_000)
    assert.equal(getCached('big'), null)
    assert.equal(getStats().size, 0)
  })

  test('刚好在上限内的可以缓存', () => {
    const ok = 'x'.repeat(1024)
    setCached('ok', ok, 60_000)
    assert.equal(getCached('ok'), ok)
  })

  test('条目数超上限时淘汰，不会无限增长', () => {
    for (let i = 0; i < 150; i++) setCached(`k${i}`, `v${i}`, 60_000)
    assert.ok(getStats().size <= 100, `期望 <=100，实际 ${getStats().size}`)
  })

  test('淘汰优先清过期条目', () => {
    for (let i = 0; i < 100; i++) setCached(`dead${i}`, 'v', -1)  // 全过期
    setCached('alive', 'keep', 60_000)
    assert.equal(getCached('alive'), 'keep')
  })
})
