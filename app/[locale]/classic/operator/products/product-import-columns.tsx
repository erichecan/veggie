import type { BulkImportColumn } from '@/components/shared/BulkImportDialog'

/**
 * 商品批量导入列定义(20260930 定稿，20261003 从 ProductImportDialog 抽到独立配置，
 * 改走全站通用的 BulkImportDialog)。
 *
 * 列头与 lib/export/columns/product-templates.ts 的导出列**逐一对应**(同一份
 * ProductNo/Internal Reference/.../Sellable Units 顺序)，保证"导出 → Excel 改 →
 * 重新导入"这条路径能直接用同一份文件；文件里额外带出的 Product No./Sequence/
 * Forecast Quantity/Created·Updated 这几列是导出时的只读信息，这里读到了也直接
 * 忽略，不当错误处理。
 *
 * 末尾另加 Description/Spec/Status/Can Be Sold/Can Be Purchased/Tracking 六列 ——
 * 导出里没有它们，但批量导入本身要支持这些字段，所以模板里单独补上。
 */

const TYPE_LABEL_TO_CODE: Record<string, string> = {
  'storable product': 'product',
  'consumable': 'consu',
  'service': 'service',
  '可库存商品': 'product',
  '耗材': 'consu',
  '服务': 'service',
}

/** "Customer Taxes (%)"/"Vendor Taxes (%)" 导出时是 13.5 这样的百分数，库里存的是
 * 小数 0.135——导入要在这里除回去，不能指望服务端猜单位。 */
function percentToFraction(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? String(n / 100) : raw
}

/** 允许直接填 product/consu/service，也允许原样贴导出出来的英文长标签(Storable Product 等)。 */
function normalizeType(raw: string): string {
  const s = raw.trim().toLowerCase()
  return TYPE_LABEL_TO_CODE[s] ?? s
}

export const PRODUCT_IMPORT_COLUMNS: BulkImportColumn[] = [
  // 20261 追加：接回匹配-更新逻辑的最高优先级键——productNo 是数据库自动生成、
  // 每个商品必有、永不改变的编号，天然就在导出的第一列，用它做匹配键才能保证
  // 批量更新对整个商品库都可靠，不依赖历史数据是否填过内部编号/条码。
  { label: 'Product No.', key: 'productNo' },
  { label: 'Internal Reference', key: 'internalRef' },
  { label: 'Barcode', key: 'barcode' },
  { label: 'ID', key: 'externalId' },
  { label: 'Sequence' },
  { label: 'Name', key: 'name', required: true },
  { label: 'Sale Description', key: 'saleDescription' },
  { label: 'Sale Price (€)', key: 'listPrice' },
  { label: 'Customer Taxes (%)', key: 'customerTaxRate', parse: percentToFraction },
  { label: 'Cost (€)', key: 'standardPrice' },
  { label: 'Vendor Taxes (%)', key: 'vendorTaxRate', parse: percentToFraction },
  { label: 'Weight (kg)', key: 'weight' },
  { label: 'Net Weight (kg)', key: 'netWeight' },
  { label: 'Volume (L)', key: 'volume' },
  { label: 'Quantity On Hand', key: 'qtyOnHand' },
  { label: 'Forecast Quantity' },
  { label: 'Product Category', key: 'category' },
  { label: 'Unit of Measure', key: 'uomName' },
  { label: 'Purchase UoM', key: 'purchaseUomName' },
  { label: 'Sellable Units (unit:factor:default:spec:sequence:grossWeight)', key: 'saleUoms' },
  { label: 'Product Type', key: 'type', parse: normalizeType },
  { label: 'Commission Price (€)', key: 'commissionPrice' },
  { label: 'Created by' },
  { label: 'Created on' },
  { label: 'Last Updated by' },
  { label: 'Last Updated on' },
  { label: 'Description', key: 'description' },
  { label: 'Spec', key: 'spec' },
  { label: 'Status', key: 'status' },
  { label: 'Can Be Sold', key: 'canBeSold' },
  { label: 'Can Be Purchased', key: 'canBePurchased' },
  { label: 'Tracking', key: 'tracking' },
]

export const PRODUCT_IMPORT_EXAMPLE_ROWS: string[][] = [
  // 示例 1：多规格(基础单位 PKT，另有整箱 CASE)——CASE 这一行顺带演示可选的
  // 产品规格/装货顺序/毛重 3 段(跟在 Y|N 后面，"CASE:10:N:6*700g:3:8.4")
  ['', '', '', '', '', 'ASIAN CHOICE Black Tiger Shrimp 700g', '', '12.50', '13.5', '8.00', '13.5',
    '0.7', '0.7', '', '100', '', 'Frozen', 'PKT', 'CASE', 'PKT:1:Y; CASE:10:N:6*700g:3:8.4', 'consu', '1.00',
    '', '', '', '', '', '', 'active', 'Y', 'Y', 'none'],
  // 示例 2：单一单位，不配可售单位
  ['', 'DEMO-002', '', '', '', 'Demo Potato 5kg Bag', '', '6.90', '0', '4.20', '0',
    '5', '5', '', '50', '', '', 'KG', 'KG', '', 'consu', '',
    '', '', '', '', '', '', 'active', 'Y', 'Y', 'none'],
]

export const PRODUCT_IMPORT_HINT = {
  zh: '第一行为表头。列名与商品导出完全一致，导出的 CSV 改完可直接重新导入。仅「Name」必填。',
  en: 'Row 1 is the header. Columns match the product export exactly, so an exported CSV can be edited and re-imported. Name is the only required column.',
}

export const PRODUCT_IMPORT_EXTRA_HINT = {
  zh: (
    <>按「产品编号 → 内部编号 → 条码 → ID」精确匹配更新对应商品——保留从导出文件带出的「产品编号」列,即使内部编号是空的也能可靠更新价格/分类;都没匹配上则按名称判重(撞了跳过,不覆盖),否则新建。<b>可售单位</b>格式:<code>单位名:系数:Y|N</code>,用 <code>;</code> 分隔,如 <code>PKT:1:Y; CASE:10:N</code>——可以在后面再接 <code>:产品规格:装货顺序:毛重</code>(如 <code>CASE:10:N:6*700g:3:8.4</code>)顺带把这个单位的「产品规格/装货顺序(0-8)/毛重」也设好;某一段不想填就留空。</>
  ),
  en: (
    <>Matched by Product No. → Internal Reference → Barcode → ID (exact match) updates that product — keep the Product No. column from an exported file to reliably update prices/categories even when Internal Reference is blank; otherwise a name collision is skipped, no match creates a new one. Format for <b>Sellable Units</b>: <code>UomName:factor:Y|N</code> separated by <code>;</code>, e.g. <code>PKT:1:Y; CASE:10:N</code> — optionally append <code>:spec:sequence:grossWeight</code> per unit (e.g. <code>CASE:10:N:6*700g:3:8.4</code>) to also set per-unit Product Spec / Pack Sequence(0-8) / Gross Weight; leave a segment empty to skip just that field.</>
  ),
}
