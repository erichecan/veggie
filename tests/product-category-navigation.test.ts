import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCategoryNavigation, categoryParentChoices } from '../lib/product-category-navigation'

const categories = [
  { id: 'food', name: 'Food', parentId: null },
  { id: 'veg', name: 'Vegetables', parentId: 'food' },
  { id: 'leaf', name: 'Leafy vegetables', parentId: 'veg' },
  { id: 'other', name: 'Other', parentId: null },
]

test('navigation keeps complete paths and depth for each level', () => {
  const entries = buildCategoryNavigation(categories)
  assert.deepEqual(entries.map(entry => entry.node.id), ['food', 'veg', 'leaf', 'other'])
  assert.deepEqual(entries.find(entry => entry.node.id === 'leaf')?.path.map(node => node.id), ['food', 'veg', 'leaf'])
  assert.equal(entries.find(entry => entry.node.id === 'leaf')?.node.depth, 3)
  assert.equal(entries[0].node.children[0].id, 'veg')
  assert.equal('children' in categories[0], false)
})

test('new categories can only choose level one or two parents', () => {
  assert.deepEqual(categoryParentChoices(categories, null).map(entry => entry.node.id), ['food', 'veg', 'other'])
})

test('moving a branch excludes self, descendants and parents that make the subtree too deep', () => {
  assert.deepEqual(categoryParentChoices(categories, 'food'), [])
  assert.deepEqual(categoryParentChoices(categories, 'veg').map(entry => entry.node.id), ['food', 'other'])
})

test('navigation follows a moved or renamed category without stale ancestor state', () => {
  const moved = categories.map(category => category.id === 'leaf' ? { ...category, parentId: 'other', name: 'Renamed' } : category)
  const entry = buildCategoryNavigation(moved).find(item => item.node.id === 'leaf')
  assert.deepEqual(entry?.path.map(node => node.name), ['Other', 'Renamed'])
  assert.equal(entry?.node.depth, 2)
})

test('empty and deleted selections have no path, remaining categories keep their order', () => {
  assert.deepEqual(buildCategoryNavigation([]), [])
  const entries = buildCategoryNavigation(categories.filter(category => category.id !== 'leaf'))
  assert.equal(entries.find(entry => entry.node.id === 'leaf'), undefined)
  assert.deepEqual(entries.filter(entry => entry.node.depth === 1).map(entry => entry.node.id), ['food', 'other'])
})
