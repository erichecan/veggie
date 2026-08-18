/**
 * 导出列定义的行为锁 —— 这份列定义被服务端路由和浏览器端本地导出共用，
 * 改动它就是同时改两条路的输出，值得逐格锁住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportHeaders, exportRows, type ExportColumn } from '../lib/export/types'
import { buildCsv } from '../lib/export/csv'
import {
  PRODUCT_TEMPLATE_EXPORT_COLUMNS,
  type ProductExportRow,
} from '../lib/export/columns/product-templates'

const cols: ExportColumn<{ a: number; b: string }>[] = [
  { header: '甲', headerEn: 'A', get: r => r.a },
  { header: '乙', get: r => r.b },
]

test('表头按 locale 取，没有英文时回落中文', () => {
  assert.deepEqual(exportHeaders(cols, false), ['甲', '乙'])
  assert.deepEqual(exportHeaders(cols, true), ['A', '乙'])
})

test('行按列顺序取值', () => {
  assert.deepEqual(exportRows(cols, [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]), [[1, 'x'], [2, 'y']])
})

const HEADERS = PRODUCT_TEMPLATE_EXPORT_COLUMNS.map(c => c.header)
const byHeader = (row: ProductExportRow, header: string) => {
  const col = PRODUCT_TEMPLATE_EXPORT_COLUMNS.find(c => c.header === header)
  assert.ok(col, `没有这一列: ${header}`)
  return col.get(row)
}

test('商品导出列与列表页表格一一对应', () => {
  // 屏幕上的列（app/[locale]/classic/operator/products/page.tsx 的 columns）
  assert.deepEqual(HEADERS, [
    'Internal Reference', 'ID', 'Sequence', 'Name', 'Sale Description',
    'Sale Price (€)', 'Customer Taxes (%)', 'Cost (€)', 'Vendor Taxes (%)',
    'Weight (kg)', 'Quantity On Hand', 'Forecast Quantity', 'Product Category',
    'Unit of Measure', 'Product Type', 'Commission Price (€)',
    'Created by', 'Created on', 'Last Updated by', 'Last Updated on',
  ])
})

test('税率库里存小数、屏幕显示百分比 → 导出成不带 % 的数字', () => {
  assert.equal(byHeader({ customerTaxRate: 0.135 }, 'Customer Taxes (%)'), '13.5')
  assert.equal(byHeader({ customerTaxRate: 0.23 }, 'Customer Taxes (%)'), '23')
  assert.equal(byHeader({ customerTaxRate: 0 }, 'Customer Taxes (%)'), '0')
  assert.equal(byHeader({}, 'Customer Taxes (%)'), '', '没有税率时留空，不写 0')
})

test('金额与数量按屏幕的小数位，但不带货币符号（带了 Excel 就当文本）', () => {
  assert.equal(byHeader({ listPrice: 55 }, 'Sale Price (€)'), '55.00')
  assert.equal(byHeader({ standardPrice: null }, 'Cost (€)'), '0.00', '屏幕上成本空值显示 €0.00')
  assert.equal(byHeader({ commissionPrice: null }, 'Commission Price (€)'), '', '屏幕上提成价空值显示 —')
  assert.equal(byHeader({ qtyOnHand: -3 }, 'Quantity On Hand'), '-3.0')
  assert.equal(byHeader({ qtyOnHand: null }, 'Quantity On Hand'), '0.0')
  assert.equal(byHeader({ weight: 6.3 }, 'Weight (kg)'), '6.30')
})

test('商品类型翻成屏幕上的说法，大小写都认', () => {
  assert.equal(byHeader({ type: 'PRODUCT' }, 'Product Type'), 'Storable Product')
  assert.equal(byHeader({ type: 'consu' }, 'Product Type'), 'Consumable')
  assert.equal(byHeader({ type: 'weird' }, 'Product Type'), 'weird', '未知类型原样输出，不吞')
})

test('日期用 yyyy-mm-dd，不用会被 Excel 猜错月日的 dd/mm/yyyy', () => {
  assert.equal(byHeader({ createdAt: '2026-03-02T10:00:00.000Z' }, 'Created on'), '2026-03-02')
  assert.equal(byHeader({ createdAt: null }, 'Created on'), '')
  assert.equal(byHeader({ updatedAt: 'not a date' }, 'Last Updated on'), '')
})

test('创建人/修改人空值回落 Administrator，与屏幕一致', () => {
  assert.equal(byHeader({}, 'Created by'), 'Administrator')
  assert.equal(byHeader({ updatedBy: 'eric' }, 'Last Updated by'), 'eric')
})

test('商品名里的逗号和引号不会把 CSV 撑错列', () => {
  const csv = buildCsv(
    exportHeaders(PRODUCT_TEMPLATE_EXPORT_COLUMNS, false),
    exportRows(PRODUCT_TEMPLATE_EXPORT_COLUMNS, [
      { name: '26/30 PD Prawn IQF (Black Box), 6*800g', saleDescription: '无头无壳虾 "Black Box"' },
    ]),
  )
  const dataLine = csv.split('\r\n')[1]
  assert.ok(dataLine.includes('"26/30 PD Prawn IQF (Black Box), 6*800g"'), '含逗号的字段要加引号')
  assert.ok(dataLine.includes('"无头无壳虾 ""Black Box"""'), '引号要转义成两个')
  assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV 必须带 BOM，否则 Excel 中文乱码')
})
