import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffPricelistItems, ruleChangesToLogChanges, ruleLogsByProduct, ruleSummary } from '../lib/pricelist-diff'
import { fieldLabel } from '../lib/action-log-i18n'

const fixed = (id: string, productId: string, price: number, extra: Record<string, unknown> = {}) => ({
  id, applyOn: 'variant', productVariantId: productId, computeType: 'fixed', fixedPrice: price, minQty: 0, ...extra,
})

test('diffPricelistItems：改价、新增、删除按规则 id 对齐', () => {
  const before = [fixed('a', 'p1', 10), fixed('b', 'p2', 5), { id: 'c', applyOn: 'global', computeType: 'percentage', percentDiscount: 5 }]
  const after = [fixed('a', 'p1', 12), { id: 'c', applyOn: 'global', computeType: 'percentage', percentDiscount: 5, sequence: 3 }, fixed('d', 'p3', 7)]
  const changes = diffPricelistItems(before, after)
  const byId = Object.fromEntries(changes.map(c => [c.itemId, c]))
  assert.equal(byId.a.kind, 'changed')
  assert.deepEqual(byId.a.fields, { fixedPrice: { before: 10, after: 12 } })
  assert.equal(byId.d.kind, 'added')
  assert.equal(byId.b.kind, 'removed')
  assert.equal(byId.c, undefined, '只改 sequence 不算改价')
})

test('diffPricelistItems：字符串数字与数字视为相同，规则改挂商品拆成删除+新增', () => {
  assert.equal(diffPricelistItems([fixed('a', 'p1', 10)], [fixed('a', 'p1', '10' as unknown as number)]).length, 0)
  const moved = diffPricelistItems([fixed('a', 'p1', 10)], [fixed('a', 'p2', 10)])
  assert.deepEqual(moved.map(c => [c.kind, c.productId]), [['removed', 'p1'], ['added', 'p2']])
})

test('ruleChangesToLogChanges：同一商品多条规则不互相覆盖，超限截断', () => {
  const changes = diffPricelistItems([fixed('a', 'p1', 10), fixed('b', 'p1', 9, { minQty: 5 })], [fixed('a', 'p1', 11), fixed('b', 'p1', 8, { minQty: 5 })])
  const out = ruleChangesToLogChanges(changes, () => 'Apple [#1]')
  assert.deepEqual(Object.keys(out), ['Apple [#1] · fixedPrice', 'Apple [#1] (2) · fixedPrice'])
  const many = diffPricelistItems([], Array.from({ length: 5 }, (_, i) => fixed(`x${i}`, `p${i}`, i)))
  const cut = ruleChangesToLogChanges(many, c => c.productId ?? '', 3)
  assert.deepEqual(cut.moreRuleChanges, { before: null, after: 2 })
})

test('ruleLogsByProduct：只落到具体商品，分类/全场规则不展开', () => {
  const changes = diffPricelistItems(
    [fixed('a', 'p1', 10), { id: 'g', applyOn: 'category', categoryId: 'c1', computeType: 'fixed', fixedPrice: 1 }],
    [fixed('a', 'p1', 12, { minQty: 3 }), { id: 'g', applyOn: 'category', categoryId: 'c1', computeType: 'fixed', fixedPrice: 2 }],
  )
  const logs = ruleLogsByProduct(changes, 'VIP')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].productId, 'p1')
  assert.deepEqual(logs[0].changes['VIP (≥3) · fixedPrice'], { before: 10, after: 12 })
})

test('ruleSummary 与 fieldLabel 翻译「对象 · 字段」', () => {
  assert.equal(ruleSummary({ computeType: 'fixed', fixedPrice: 3.5 }), 'Fixed 3.5')
  assert.equal(ruleSummary({ computeType: 'percentage', percentDiscount: 10, minQty: 2 }), '-10% (≥2)')
  assert.equal(fieldLabel('Apple [#1] · fixedPrice', true), 'Apple [#1] · Fixed Price')
  assert.equal(fieldLabel('Apple [#1] · fixedPrice', false), 'Apple [#1] · 固定价')
  assert.equal(fieldLabel('random key', true), 'random key')
})
