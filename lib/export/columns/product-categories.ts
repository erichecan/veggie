/**
 * 产品分类(ProductCategory)导出列 —— 20261003 补齐(此前这个模块完全没有导入导出)。
 */
import type { ExportColumn } from '../types'

export interface ProductCategoryExportRow {
  externalId?: string | null
  name?: string | null
  nameZh?: string | null
  groupName?: string | null
  requiredZoneName?: string | null
}

export const PRODUCT_CATEGORY_EXPORT_COLUMNS: readonly ExportColumn<ProductCategoryExportRow>[] = [
  { key: 'externalId', header: 'ID', headerEn: 'ID', get: r => r.externalId ?? '' },
  { key: 'name', header: '名称', headerEn: 'Name', get: r => r.name ?? '' },
  { key: 'nameZh', header: '中文名称', headerEn: 'Chinese Name', get: r => r.nameZh ?? '' },
  { key: 'groupName', header: '采购品类分组', headerEn: 'Purchase Group', get: r => r.groupName ?? '' },
  { key: 'requiredZoneName', header: '应放温区', headerEn: 'Required Zone', get: r => r.requiredZoneName ?? '' },
]
