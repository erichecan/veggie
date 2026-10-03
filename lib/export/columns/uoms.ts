/**
 * 计量单位(Uom)导出列 —— 20261003 补齐(此前这个模块完全没有导入导出)。
 */
import type { ExportColumn } from '../types'

export interface UomExportRow {
  name?: string | null
  nameZh?: string | null
  categoryName?: string | null
  goodsType?: string | null
  expandByCustomer?: boolean | null
  active?: boolean | null
}

export const UOM_EXPORT_COLUMNS: readonly ExportColumn<UomExportRow>[] = [
  { key: 'name', header: '名称', headerEn: 'Name', get: r => r.name ?? '' },
  { key: 'nameZh', header: '中文名称', headerEn: 'Chinese Name', get: r => r.nameZh ?? '' },
  { key: 'categoryName', header: '单位分类', headerEn: 'Category', get: r => r.categoryName ?? '' },
  { key: 'goodsType', header: '货物类型', headerEn: 'Goods Type', get: r => r.goodsType ?? '' },
  {
    key: 'expandByCustomer',
    header: '拣货按客户展开', headerEn: 'Picking Detail by Customer',
    get: r => (r.expandByCustomer ? 'Y' : 'N'),
  },
  { key: 'active', header: '状态', headerEn: 'Status', get: r => (r.active !== false ? '启用' : '停用') },
]
