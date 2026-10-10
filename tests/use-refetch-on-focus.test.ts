import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefetch } from '../lib/hooks/use-refetch-on-focus'

test('shouldRefetch 未到节流间隔时不刷新', () => {
  assert.equal(shouldRefetch(1000, 1000 + 29_000, 30_000), false)
})

test('shouldRefetch 刚好到节流间隔允许刷新', () => {
  assert.equal(shouldRefetch(1000, 1000 + 30_000, 30_000), true)
})

test('shouldRefetch 超过节流间隔允许刷新', () => {
  assert.equal(shouldRefetch(1000, 1000 + 60_000, 30_000), true)
})

test('shouldRefetch 节流间隔为 0 时每次都允许刷新', () => {
  assert.equal(shouldRefetch(1000, 1000, 0), true)
})
