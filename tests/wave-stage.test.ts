/**
 * 配送调度台批次展示阶段判定。优先级：completed > in_transit > assignment_done > assigning。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waveStage } from '../lib/wave-stage'

const D = '2026-07-03T08:00:00.000Z'

test('三标记皆空 → assigning', () => {
  assert.equal(waveStage({ assignmentDoneAt: null, dispatchedAt: null, completedAt: null }), 'assigning')
})

test('仅 assignmentDoneAt → assignment_done', () => {
  assert.equal(waveStage({ assignmentDoneAt: D, dispatchedAt: null, completedAt: null }), 'assignment_done')
})

test('dispatchedAt 压过 assignmentDoneAt → in_transit', () => {
  assert.equal(waveStage({ assignmentDoneAt: D, dispatchedAt: D, completedAt: null }), 'in_transit')
})

test('completedAt 压过一切 → completed', () => {
  assert.equal(waveStage({ assignmentDoneAt: D, dispatchedAt: D, completedAt: D }), 'completed')
})

test('接受 Date 对象', () => {
  assert.equal(waveStage({ assignmentDoneAt: new Date(D), dispatchedAt: null, completedAt: null }), 'assignment_done')
})
