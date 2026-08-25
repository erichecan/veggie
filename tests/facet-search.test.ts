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

// ── 客户端类页面的维度定义（以发票为样板）──────────────────────────────────
import { INVOICE_FACET_DEFS, fieldsOf } from '../lib/facets/client-defs'

const INVOICES = [
  { id: '1', name: 'INV-001', customerName: 'Fuji Ltd',  status: 'draft',  paymentTerms: 'cash' },
  { id: '2', name: 'INV-002', customerName: 'Rongcheng', status: 'posted', paymentTerms: 'monthly' },
  { id: '3', name: 'INV-003', customerName: 'Fuji Ltd',  status: 'posted', paymentTerms: 'weekly' },
] as unknown as Parameters<typeof filterByFacets<never>>[0]

test('发票维度：同维度 OR、跨维度 AND 与服务端一致', () => {
  const f = (fs: { key: string; label: string; value: string }[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (filterByFacets(INVOICES as any, fs, INVOICE_FACET_DEFS as any) as any[]).map(r => r.name)

  assert.deepEqual(f([{ key: 'customer', label: '客户', value: 'Fuji' }]), ['INV-001', 'INV-003'])
  assert.deepEqual(f([
    { key: 'customer', label: '客户', value: 'Fuji' },
    { key: 'customer', label: '客户', value: 'Rong' },
  ]), ['INV-001', 'INV-002', 'INV-003'], '同维度多值 → OR 扩大')
  assert.deepEqual(f([
    { key: 'customer', label: '客户', value: 'Fuji' },
    { key: 'status',   label: '状态', value: 'posted' },
  ]), ['INV-003'], '跨维度 → AND 收窄')
})

test('fieldsOf 从 defs 派生下拉项，key/label 与 defs 一致', () => {
  assert.deepEqual(fieldsOf(INVOICE_FACET_DEFS).map(f => f.key), ['name', 'customer', 'status', 'terms'])
})

// ── 'all'（全部）维度：曾经是唯一一个不走 buildFacetWhere 的维度 ─────────────
// 客户反馈（20260820）：商品列表先搜 "pepper g" 再搜 "scall"，chip 显示
// "pepper g or scall"，结果却只有 pepper。根因：'all' 走各路由自己手写的
// `searchParams.get('search')` —— getAll 变成 get，第二个词被静默丢掉。
// 现在 'all' 与其它维度一样是一条 FacetDef，语义由 buildFacetWhere 统一保证。
import { PRODUCT_TEMPLATE_FACET_DEFS } from '../lib/facets/product-templates'
import { CUSTOMER_FACET_DEFS } from '../lib/facets/customers'
import { PURCHASE_ORDER_FACET_DEFS } from '../lib/facets/purchase-orders'
import { ORDER_FACET_DEFS } from '../lib/orders-query'
import {
  ORDER_FACET_FIELDS, PRODUCT_FACET_FIELDS, CUSTOMER_FACET_FIELDS, PURCHASE_FACET_FIELDS,
} from '../lib/list-filters'

const RESOURCES: { name: string; fields: { key: string; label: string }[]; defs: FacetDef[] }[] = [
  { name: '商品',   fields: PRODUCT_FACET_FIELDS,  defs: PRODUCT_TEMPLATE_FACET_DEFS },
  { name: '客户',   fields: CUSTOMER_FACET_FIELDS, defs: CUSTOMER_FACET_DEFS },
  { name: '订单',   fields: ORDER_FACET_FIELDS,    defs: ORDER_FACET_DEFS },
  { name: '采购单', fields: PURCHASE_FACET_FIELDS, defs: PURCHASE_ORDER_FACET_DEFS },
]

test('下拉里的每个维度后端都有实现（含 all，否则搜了等于没搜）', () => {
  for (const r of RESOURCES) {
    const implemented = new Set(r.defs.map(d => d.key))
    for (const f of r.fields) {
      assert.ok(implemented.has(f.key), `${r.name} 维度 ${f.key} 在下拉里可选，但后端没有对应 FacetDef`)
    }
  }
})

test("all 维度多值 → OR（客户反馈：'pepper g or scall' 只出 pepper）", async () => {
  const sp = new URLSearchParams()
  sp.append('search', 'pepper g')
  sp.append('search', 'scall')
  const clauses = await buildFacetWhere(sp, PRODUCT_TEMPLATE_FACET_DEFS)
  assert.equal(clauses.length, 1, 'all 只产出一个子句')
  const or = (clauses[0] as { OR?: unknown[] }).OR
  assert.equal(or?.length, 2, '两个关键词各一条，彼此 OR')
  assert.deepEqual(JSON.parse(JSON.stringify(or)), [
    { OR: [{ name: { contains: 'pepper g', mode: 'insensitive' } }, { internalRef: { contains: 'pepper g', mode: 'insensitive' } }, { description: { contains: 'pepper g', mode: 'insensitive' } }, { saleDescription: { contains: 'pepper g', mode: 'insensitive' } }] },
    { OR: [{ name: { contains: 'scall',    mode: 'insensitive' } }, { internalRef: { contains: 'scall',    mode: 'insensitive' } }, { description: { contains: 'scall',    mode: 'insensitive' } }, { saleDescription: { contains: 'scall',    mode: 'insensitive' } }] },
  ])
})

test('all 维度单值 → 与旧的 search 参数完全等价（含 20260825 补的描述字段）', async () => {
  const clauses = await buildFacetWhere(new URLSearchParams('search=salt'), PRODUCT_TEMPLATE_FACET_DEFS)
  assert.deepEqual(JSON.parse(JSON.stringify(clauses)), [
    { OR: [{ name: { contains: 'salt', mode: 'insensitive' } }, { internalRef: { contains: 'salt', mode: 'insensitive' } }, { description: { contains: 'salt', mode: 'insensitive' } }, { saleDescription: { contains: 'salt', mode: 'insensitive' } }] },
  ])
})

// ── 搜索框里直接写 "a or b" ────────────────────────────────────────────────
import { splitOrTerms } from '../lib/list-filters'

test('输入 "a or b" 拆成两个关键词（chip 就是这么显示的，用户照着输）', () => {
  assert.deepEqual(splitOrTerms('pepper g or scall'), ['pepper g', 'scall'])
  assert.deepEqual(splitOrTerms('salt OR ketch or  odlum '), ['salt', 'ketch', 'odlum'])
})

test('只认独立的 or：商品名里的 or 不被拆开', () => {
  assert.deepEqual(splitOrTerms('Orange Juice'), ['Orange Juice'])
  assert.deepEqual(splitOrTerms('Flavour'), ['Flavour'])
  assert.deepEqual(splitOrTerms('  '), [])
})
