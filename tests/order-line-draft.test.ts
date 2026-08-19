/**
 * 草稿行 id 的进出规则。
 *
 * 这组测试守的是一条**会直接打坏保存**的约束：后端
 * `app/api/orders/[id]/route.ts` 用 `if (l.id)` 决定 update 还是 create，
 * 所以新行提交时 id 必须为空。前端为了 React key 又必须给新行一个唯一 id，
 * 两者的交接就在 `stripDraftId` / `toSubmittableLines`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newDraftLineId,
  isDraftLineId,
  stripDraftId,
  toSubmittableLines,
} from '../lib/order-line-draft'

test('草稿 id 互不相同 —— 否则 OrderLineEditor 的 key 会撞车', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newDraftLineId()))
  assert.equal(ids.size, 50)
})

test('草稿 id 认得出来，真实 cuid 不会被误判', () => {
  assert.equal(isDraftLineId(newDraftLineId()), true)
  assert.equal(isDraftLineId(''), true, '空串是老的草稿表示法，同样算新行')
  assert.equal(isDraftLineId(null), true)
  assert.equal(isDraftLineId(undefined), true)
  assert.equal(isDraftLineId('cmrogw1l935x3fvylve02f8z8'), false)
})

test('提交前草稿 id 必须抹成空串 —— 后端靠它走 create', () => {
  const draft = { id: newDraftLineId(), productName: 'Tomato Beef CASE' }
  assert.equal(stripDraftId(draft).id, '')
})

test('已落库的行 id 必须原样保留 —— 抹掉会变成重复插入', () => {
  const existing = { id: 'cmrogw1l935x3fvylve02f8z8', productName: 'Tomato Beef CASE' }
  assert.equal(stripDraftId(existing).id, 'cmrogw1l935x3fvylve02f8z8')
})

test('stripDraftId 不改原对象', () => {
  const id = newDraftLineId()
  const draft = { id, productName: 'X' }
  stripDraftId(draft)
  assert.equal(draft.id, id)
})

test('整批提交：新行清空、老行保留、sequence 按当前顺序重排', () => {
  const lines = [
    { id: 'cmrogw1l935x3fvylve02f8z8', productName: '老行A', sequence: 7 },
    { id: newDraftLineId(), productName: '新行B', sequence: 99 },
    { id: newDraftLineId(), productName: '新行C', sequence: 99 },
    { id: 'cmszfivyb0005ujsic1huilxd', productName: '老行D', sequence: 3 },
  ]
  const out = toSubmittableLines(lines)

  assert.deepEqual(out.map(l => l.id), [
    'cmrogw1l935x3fvylve02f8z8', '', '', 'cmszfivyb0005ujsic1huilxd',
  ])
  assert.deepEqual(out.map(l => l.sequence), [0, 1, 2, 3])
  assert.deepEqual(out.map(l => l.productName), ['老行A', '新行B', '新行C', '老行D'])
})

test('连加多行后提交，没有任何一个非空的草稿 id 漏出去', () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({
    id: newDraftLineId(), productName: `新行${i}`,
  }))
  const out = toSubmittableLines(lines)
  // 漏一个都会让后端拿不存在的 id 去 update，整单保存失败
  assert.equal(out.every(l => l.id === ''), true)
})
