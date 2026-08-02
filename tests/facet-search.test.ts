/**
 * 分面搜索 v2 语义：同一维度内多值 OR，不同维度之间 AND。
 * 对应 docs/20260802-list-facet-search-v2-plan.md
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFacets, groupFacets } from '../lib/list-filters'
import { filterByFacets, type ClientFacetDef } from '../lib/facet-client'
import { buildFacetWhere, type FacetDef } from '../lib/facet-sql'

interface Row { name: string; category: string | null }
const ROWS: Row[] = [
  { name: 'Cooking Salt 25KG BAG',        category: 'Dry Food' },
  { name: 'CHEF Tomato Ketchup 4*5.6kg',  category: 'sauce' },
  { name: 'Odlums Cream Plain Flour 25Kg', category: 'Dry Food' },
  { name: 'Sea Salt Fine',                category: null },
]
const DEFS: ClientFacetDef<Row>[] = [
  { key: 'product',  label: '产品', values: r => [r.name] },
  { key: 'category', label: '类目', values: r => [r.category] },
]
const names = (rows: Row[]) => rows.map(r => r.name)

test('同一维度的多个值全部写入 URL（不再互相覆盖）', () => {
  const params = new URLSearchParams()
  applyFacets(params, [
    { key: 'product', label: '产品', value: 'odlum' },
    { key: 'product', label: '产品', value: 'ketch' },
  ])
  assert.deepEqual(params.getAll('f_product'), ['odlum', 'ketch'])
})

test('同一维度内重复值去重（大小写不敏感）', () => {
  const params = new URLSearchParams()
  applyFacets(params, [
    { key: 'product', label: '产品', value: 'salt' },
    { key: 'product', label: '产品', value: 'SALT' },
    { key: 'product', label: '产品', value: 'ketch' },
  ])
  assert.deepEqual(params.getAll('f_product'), ['salt', 'ketch'])
})

test('不同维度的同名值互不去重', () => {
  const params = new URLSearchParams()
  applyFacets(params, [
    { key: 'product',  label: '产品', value: 'salt' },
    { key: 'category', label: '类目', value: 'salt' },
  ])
  assert.deepEqual(params.getAll('f_product'), ['salt'])
  assert.deepEqual(params.getAll('f_category'), ['salt'])
})

test('同一维度多值 → OR（截图诉求①：一次筛出多种产品）', () => {
  const out = filterByFacets(ROWS, [
    { key: 'product', label: '产品', value: 'salt' },
    { key: 'product', label: '产品', value: 'ketch' },
  ], DEFS)
  assert.deepEqual(names(out), ['Cooking Salt 25KG BAG', 'CHEF Tomato Ketchup 4*5.6kg', 'Sea Salt Fine'])
})

test('不同维度之间 → AND（截图诉求③：加条件应收窄而非扩大）', () => {
  const out = filterByFacets(ROWS, [
    { key: 'product',  label: '产品', value: 'salt' },
    { key: 'category', label: '类目', value: 'Dry Food' },
  ], DEFS)
  assert.deepEqual(names(out), ['Cooking Salt 25KG BAG'])
})

test('无分面时原样返回全部行', () => {
  assert.deepEqual(names(filterByFacets(ROWS, [], DEFS)), names(ROWS))
})

test('字段为 null 的行不报错，且不被误匹配', () => {
  const out = filterByFacets(ROWS, [{ key: 'category', label: '类目', value: 'sauce' }], DEFS)
  assert.deepEqual(names(out), ['CHEF Tomato Ketchup 4*5.6kg'])
})

test('未在 defs 中声明的维度被忽略，不参与 AND', () => {
  const out = filterByFacets(ROWS, [
    { key: 'product', label: '产品', value: 'salt' },
    { key: 'unknown_dimension', label: '未知', value: 'zzz' },
  ], DEFS)
  assert.deepEqual(names(out), ['Cooking Salt 25KG BAG', 'Sea Salt Fine'])
})

const SQL_DEFS: FacetDef[] = [
  { key: 'product',  label: '产品', toClause: v => ({ name: { contains: v, mode: 'insensitive' } }) },
  { key: 'category', label: '类目', toClause: v => ({ category: { name: { contains: v, mode: 'insensitive' } } }) },
]

test('服务端：同一维度多值 → 包成 OR', async () => {
  const sp = new URLSearchParams([['f_product', 'salt'], ['f_product', 'ketch']])
  assert.deepEqual(await buildFacetWhere(sp, SQL_DEFS), [
    { OR: [
      { name: { contains: 'salt',  mode: 'insensitive' } },
      { name: { contains: 'ketch', mode: 'insensitive' } },
    ] },
  ])
})

test('服务端：单值不包多余的 OR 层（避免影响查询计划）', async () => {
  const sp = new URLSearchParams([['f_product', 'salt']])
  assert.deepEqual(await buildFacetWhere(sp, SQL_DEFS), [
    { name: { contains: 'salt', mode: 'insensitive' } },
  ])
})

test('服务端：不同维度产出各自独立的元素，交由调用方 AND 串联', async () => {
  const sp = new URLSearchParams([['f_product', 'salt'], ['f_category', 'Dry']])
  const out = await buildFacetWhere(sp, SQL_DEFS)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { name: { contains: 'salt', mode: 'insensitive' } })
  assert.deepEqual(out[1], { category: { name: { contains: 'Dry', mode: 'insensitive' } } })
})

test('服务端：无分面参数 → 空数组', async () => {
  assert.deepEqual(await buildFacetWhere(new URLSearchParams(), SQL_DEFS), [])
})

test('服务端：空白值被丢弃', async () => {
  const sp = new URLSearchParams([['f_product', '   '], ['f_product', 'salt']])
  assert.deepEqual(await buildFacetWhere(sp, SQL_DEFS), [
    { name: { contains: 'salt', mode: 'insensitive' } },
  ])
})

test('服务端：toClause 支持 async（司机等需查库的维度）', async () => {
  const asyncDefs: FacetDef[] = [
    { key: 'driver', label: '司机', toClause: async v => ({ driverSlotId: { in: ['id-' + v] } }) },
  ]
  const sp = new URLSearchParams([['f_driver', 'BAO']])
  assert.deepEqual(await buildFacetWhere(sp, asyncDefs), [{ driverSlotId: { in: ['id-BAO'] } }])
})

test('分组：同一维度的多个值合并成一个 chip，用 or 连接', () => {
  assert.deepEqual(groupFacets([
    { key: 'product',  label: '产品', value: 'odlum' },
    { key: 'category', label: '类目', value: 'sauce' },
    { key: 'product',  label: '产品', value: 'ketch' },
  ]), [
    { key: 'product',  label: '产品', values: ['odlum', 'ketch'], chipLabel: '产品: odlum or ketch' },
    { key: 'category', label: '类目', values: ['sauce'],          chipLabel: '类目: sauce' },
  ])
})

test('分组：all 维度的 chip 只显示值本身', () => {
  assert.deepEqual(groupFacets([{ key: 'all', label: '全部', value: 'salt' }]), [
    { key: 'all', label: '全部', values: ['salt'], chipLabel: 'salt' },
  ])
})
