import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCategoryResolver, categoryPathMap } from '../lib/category-path'

const cats = [
  { id: 'all', name: 'All', parentId: null },
  { id: 'veg', name: 'Vegetables', nameZh: '蔬菜', parentId: 'all' },
  { id: 'fruit', name: 'Fruit', nameZh: '水果', parentId: 'all' },
  { id: 'vf', name: 'Frozen', parentId: 'veg' },
  { id: 'ff', name: 'Frozen', parentId: 'fruit' },
  { id: 'loop1', name: 'L1', parentId: 'loop2' },
  { id: 'loop2', name: 'L2', parentId: 'loop1' },
]

test('categoryPathMap：拼出完整路径，环不死循环', () => {
  const m = categoryPathMap(cats)
  assert.equal(m.get('vf'), 'All / Vegetables / Frozen')
  assert.equal(m.get('all'), 'All')
  assert.ok(m.get('loop1'))
  assert.equal(categoryPathMap(cats, 'nameZh').get('ff'), 'All / 水果 / Frozen')
})

test('buildCategoryResolver：完整路径 / 末几段 / 唯一名字，重名不猜', () => {
  const r = buildCategoryResolver(cats)
  assert.deepEqual(r('All / Fruit / Frozen'), { id: 'ff' })
  assert.deepEqual(r(' fruit/frozen '), { id: 'ff' })
  assert.deepEqual(r('蔬菜 / Frozen'), { id: 'vf' })
  assert.deepEqual(r('Vegetables'), { id: 'veg' })
  const amb = r('Frozen')
  assert.equal(amb.id, undefined)
  assert.equal('reason' in amb && amb.reason, 'ambiguous')
  assert.deepEqual(r('Nope'), { reason: 'not_found' })
})
