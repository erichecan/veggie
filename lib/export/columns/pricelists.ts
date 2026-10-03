/**
 * 价格表导出列 —— 20261003 补齐(此前这个模块导入是假按钮、完全没有导出)。
 *
 * 一行一条规则(OdooPricelist.items 里的一个元素)，价格表本身零规则时导出一行
 * 只填价格表级字段、规则字段留空(保证能在导出里看到这个价格表，不会因为没有
 * 规则就从文件里消失)。这个形状和 lib/import/bulk-import-engine.ts 假设的
 * "一行一条记录"不一样——价格表是"多行共享同一个父记录"，导入走独立实现
 * app/api/pricelists/bulk/route.ts，不复用那个引擎。
 */
import type { ExportColumn } from '../types'

export interface PricelistExportRow {
  externalId?: string | null
  pricelistName?: string | null
  currency?: string | null
  active?: boolean | null
  selectable?: boolean | null
  pricelistSequence?: number | null
  itemId?: string | null
  applyOn?: string | null
  categoryName?: string | null
  productName?: string | null
  minQty?: number | null
  dateStart?: string | null
  dateEnd?: string | null
  computeType?: string | null
  fixedPrice?: number | null
  percentDiscount?: number | null
  formulaBase?: string | null
  basedOnPricelistName?: string | null
  priceDiscount?: number | null
  priceSurcharge?: number | null
  priceMinMargin?: number | null
  priceMaxMargin?: number | null
  roundingMethod?: number | null
  itemSequence?: number | null
  uomName?: string | null
  badgeLabel?: string | null
}

const num = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const bool = (v: unknown) => (v ? 'Y' : 'N')

export const PRICELIST_EXPORT_COLUMNS: readonly ExportColumn<PricelistExportRow>[] = [
  { key: 'externalId', header: 'ID', headerEn: 'ID', get: r => r.externalId ?? '' },
  { key: 'pricelistName', header: '价格表名称', headerEn: 'Pricelist Name', get: r => r.pricelistName ?? '' },
  { key: 'currency', header: '币种', headerEn: 'Currency', get: r => r.currency ?? '' },
  { key: 'active', header: '启用', headerEn: 'Active', get: r => bool(r.active) },
  { key: 'selectable', header: '可选', headerEn: 'Selectable', get: r => bool(r.selectable) },
  { key: 'pricelistSequence', header: '价格表排序', headerEn: 'Pricelist Sequence', get: r => num(r.pricelistSequence) },
  { key: 'itemId', header: '规则 ID', headerEn: 'Item ID', get: r => r.itemId ?? '' },
  { key: 'applyOn', header: '适用范围', headerEn: 'Apply On', get: r => r.applyOn ?? '' },
  { key: 'categoryName', header: '分类', headerEn: 'Category', get: r => r.categoryName ?? '' },
  { key: 'productName', header: '商品', headerEn: 'Product', get: r => r.productName ?? '' },
  { key: 'minQty', header: '最小数量', headerEn: 'Min. Quantity', get: r => num(r.minQty) },
  { key: 'dateStart', header: '开始日期', headerEn: 'Start Date', get: r => r.dateStart ?? '' },
  { key: 'dateEnd', header: '结束日期', headerEn: 'End Date', get: r => r.dateEnd ?? '' },
  { key: 'computeType', header: '计算方式', headerEn: 'Compute Type', get: r => r.computeType ?? '' },
  { key: 'fixedPrice', header: '固定单价 (€)', headerEn: 'Fixed Price (€)', get: r => num(r.fixedPrice) },
  { key: 'percentDiscount', header: '折扣 (%)', headerEn: 'Percent Discount (%)', get: r => num(r.percentDiscount) },
  { key: 'formulaBase', header: '公式基准', headerEn: 'Formula Base', get: r => r.formulaBase ?? '' },
  { key: 'basedOnPricelistName', header: '嵌套价格表', headerEn: 'Based On Pricelist', get: r => r.basedOnPricelistName ?? '' },
  { key: 'priceDiscount', header: '公式折扣 (%)', headerEn: 'Formula Discount (%)', get: r => num(r.priceDiscount) },
  { key: 'priceSurcharge', header: '公式加价 (€)', headerEn: 'Formula Surcharge (€)', get: r => num(r.priceSurcharge) },
  { key: 'priceMinMargin', header: '最低利润 (€)', headerEn: 'Min Margin (€)', get: r => num(r.priceMinMargin) },
  { key: 'priceMaxMargin', header: '最高利润 (€)', headerEn: 'Max Margin (€)', get: r => num(r.priceMaxMargin) },
  { key: 'roundingMethod', header: '四舍五入精度', headerEn: 'Rounding', get: r => num(r.roundingMethod) },
  { key: 'itemSequence', header: '规则排序', headerEn: 'Item Sequence', get: r => num(r.itemSequence) },
  { key: 'uomName', header: '限定单位', headerEn: 'Unit', get: r => r.uomName ?? '' },
  { key: 'badgeLabel', header: '促销角标', headerEn: 'Promo Badge', get: r => r.badgeLabel ?? '' },
]
