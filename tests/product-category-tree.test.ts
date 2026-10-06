import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCategoryTree, CategoryTreeError, validateCategoryMove } from '../lib/product-category-tree'

const categories = [
  { id: 'food', name: 'Food', parentId: null },
  { id: 'veg', name: 'Vegetables', parentId: 'food' },
  { id: 'leaf', name: 'Leafy vegetables', parentId: 'veg' },
  { id: 'other', name: 'Other', parentId: null },
]

test('builds three levels while preserving existing top-level records and input order', () => {
  const tree = buildCategoryTree(categories)
  assert.deepEqual(tree.map(node => node.id), ['food', 'other'])
  assert.equal(tree[0].children[0].children[0].depth, 3)
  assert.equal(categories[0].parentId, null)
  assert.equal('children' in categories[0], false)
})

test('allows creating at levels one through three, rejects a fourth level', () => {
  for (const parentId of [null, 'food', 'veg']) assert.doesNotThrow(() => validateCategoryMove(categories, null, parentId))
  assert.throws(() => validateCategoryMove(categories, null, 'leaf'), CategoryTreeError)
})

test('rejects self, descendants, missing parents and missing records', () => {
  for (const parentId of ['food', 'veg', 'leaf']) assert.throws(() => validateCategoryMove(categories, 'food', parentId), CategoryTreeError)
  assert.throws(() => validateCategoryMove(categories, null, 'missing'), CategoryTreeError)
  assert.throws(() => validateCategoryMove(categories, 'missing', null), CategoryTreeError)
})

test('moving a branch validates its deepest descendant, not just its own depth', () => {
  assert.throws(() => validateCategoryMove(categories, 'food', 'other'), CategoryTreeError)
  assert.doesNotThrow(() => validateCategoryMove(categories, 'veg', 'other'))
  assert.doesNotThrow(() => validateCategoryMove(categories, 'leaf', null))
})

test('rejects pre-existing cycles without an infinite recursion', () => {
  const cycle = [{ id: 'first', parentId: 'second' }, { id: 'second', parentId: 'first' }]
  assert.throws(() => validateCategoryMove(cycle, null, 'first'), CategoryTreeError)
  assert.throws(() => validateCategoryMove(cycle, 'first', null), CategoryTreeError)
})
