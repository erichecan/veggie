import type { BulkImportColumn } from '@/components/shared/BulkImportDialog'

/**
 * 价格表批量导入列定义(20261003)。列头与 lib/export/columns/pricelists.ts 的导出列
 * 逐一对应(除了导出独有的只读展示列)，保证"导出 → Excel 改 → 重新导入"这条路径能
 * 直接用同一份文件。一行 = 一条定价规则，同一个价格表的规则靠「价格表名称」这一列分组
 * (每行都要填，不要只在第一行填、后面留空——参见 app/api/pricelists/bulk/route.ts 的说明)。
 */
export function pricelistImportColumns(isEn: boolean): BulkImportColumn[] {
  return [
    { key: 'externalId', label: isEn ? 'ID' : 'ID' },
    { key: 'pricelistName', label: isEn ? 'Pricelist Name' : '价格表名称', required: true },
    { key: 'currency', label: isEn ? 'Currency' : '币种' },
    { key: 'active', label: isEn ? 'Active (Y/N)' : '启用(Y/N)' },
    { key: 'selectable', label: isEn ? 'Selectable (Y/N)' : '可选(Y/N)' },
    { key: 'pricelistSequence', label: isEn ? 'Pricelist Sequence' : '价格表排序' },
    { key: 'itemId', label: isEn ? 'Item ID' : '规则 ID' },
    { key: 'applyOn', label: isEn ? 'Apply On (global/category/product/variant)' : '适用范围(global/category/product/variant)' },
    { key: 'category', label: isEn ? 'Category' : '分类' },
    { key: 'product', label: isEn ? 'Product' : '商品' },
    { key: 'minQty', label: isEn ? 'Min. Quantity' : '最小数量' },
    { key: 'dateStart', label: isEn ? 'Start Date (YYYY-MM-DD)' : '开始日期(YYYY-MM-DD)' },
    { key: 'dateEnd', label: isEn ? 'End Date (YYYY-MM-DD)' : '结束日期(YYYY-MM-DD)' },
    { key: 'computeType', label: isEn ? 'Compute Type (fixed/percentage/formula)' : '计算方式(fixed/percentage/formula)' },
    { key: 'fixedPrice', label: isEn ? 'Fixed Price (€)' : '固定单价 (€)' },
    { key: 'percentDiscount', label: isEn ? 'Percent Discount (%)' : '折扣 (%)' },
    { key: 'formulaBase', label: isEn ? 'Formula Base (list_price/standard_price/pricelist)' : '公式基准(list_price/standard_price/pricelist)' },
    { key: 'basedOnPricelist', label: isEn ? 'Based On Pricelist' : '嵌套价格表' },
    { key: 'priceDiscount', label: isEn ? 'Formula Discount (%)' : '公式折扣 (%)' },
    { key: 'priceSurcharge', label: isEn ? 'Formula Surcharge (€)' : '公式加价 (€)' },
    { key: 'priceMinMargin', label: isEn ? 'Min Margin (€)' : '最低利润 (€)' },
    { key: 'priceMaxMargin', label: isEn ? 'Max Margin (€)' : '最高利润 (€)' },
    { key: 'roundingMethod', label: isEn ? 'Rounding' : '四舍五入精度' },
    { key: 'itemSequence', label: isEn ? 'Item Sequence' : '规则排序' },
    { key: 'uom', label: isEn ? 'Unit' : '限定单位' },
    { key: 'badgeLabel', label: isEn ? 'Promo Badge' : '促销角标' },
  ]
}

export const PRICELIST_IMPORT_EXAMPLE_ROWS: string[][] = [
  // 示例：一个价格表、两条规则(全场9折 + 单个商品固定价)
  ['', 'Demo Wholesale 90%', 'EUR', 'Y', 'Y', '10', '', 'global', '', '', '0', '', '', 'percentage', '', '10', '', '', '', '', '', '', '0', '', '', ''],
  ['', 'Demo Wholesale 90%', 'EUR', 'Y', 'Y', '10', '', 'product', '', 'Demo Potato 5kg Bag', '0', '', '', 'fixed', '5.50', '', '', '', '', '', '', '', '0', '', '', ''],
]
