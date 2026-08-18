/**
 * 服务端导出注册表 —— 实体 → 「怎么查、导哪些列、最多导多少行」。
 * ============================================================================
 * 只被 app/api/export/[entity]/route.ts import（会拖进 Prisma，不能给 middleware 用；
 * 权限点与文件名放在 lib/export/entities.ts，那份是两端都能读的）。
 *
 * ⛔ load() 必须复用列表 API 同一个 where 构造，不得自己再拼一套查询条件。
 *    导出与列表口径分叉的唯一有效防线就是「同一个函数」—— 靠人工对照维护
 *    两份条件，迟早会在某次加筛选项时漏掉一边。
 *
 * ⛔ 行级隔离（lib/row-scope.ts）也必须走同一条路。导出是批量拿数据，
 *    这里漏一次的后果远大于列表页漏一次（参考 2026-08-02 /api/customers 泄露）。
 */
import type { JwtPayload } from '@/lib/auth'
import type { ExportColumn } from './types'
import { PRODUCT_TEMPLATE_EXPORT_COLUMNS } from './columns/product-templates'
import { loadProductTemplatesForExport } from './loaders/product-templates'
import { CUSTOMER_EXPORT_COLUMNS, CUSTOMER_EXPORT_COLUMNS_EN } from './columns/customers'
import { loadCustomersForExport } from './loaders/customers'
import { purchaseOrderExportColumns } from './columns/purchase-orders'
import { loadPurchaseOrdersForExport } from './loaders/purchase-orders'
import { orderExportColumns } from './columns/orders'
import { loadOrdersForExport } from './loaders/orders'

/** 默认行数上限，与 /api/orders/export-csv 保持一致 */
export const DEFAULT_EXPORT_ROW_LIMIT = 20000

export interface ExportLoadContext {
  /** 原始请求。有的 where 构造（如 buildOrdersWhere）要靠它做行级隔离 */
  request: Request
  /** 列表页原样传来的筛选参数 */
  searchParams: URLSearchParams
  user: JwtPayload
  /** 本次最多取多少行 */
  limit: number
  /** 界面语言 —— 分类名、单位名这类多语言字段按它取，与屏幕保持一致 */
  isEn: boolean
}

export interface ExportLoadResult<T> {
  /** 已按 limit 截断的行 */
  rows: T[]
  /** 筛选条件下的实际匹配总数（用于判断是否截断） */
  total: number
}

export interface ExportDef<T> {
  /**
   * 列定义。传函数是为了让**值**也能跟着界面语言走（如客户的「结算方式」
   * 中文显示「月结」、英文显示「Monthly」），不只是表头。
   */
  columns: readonly ExportColumn<T>[] | ((isEn: boolean) => readonly ExportColumn<T>[])
  rowLimit?: number
  load: (ctx: ExportLoadContext) => Promise<ExportLoadResult<T>>
}

/**
 * 注册表内部按「行是任意对象」存放 —— 各实体的 T 互不相同，无法用一个联合类型
 * 表达而不牺牲注册点的类型检查。这里把泛型擦除收在 defineExport 一处，
 * 注册点（下面的 EXPORT_REGISTRY）仍然是类型安全的：列定义与 load 的 T 必须对得上。
 */
type ErasedExportDef = ExportDef<Record<string, unknown>>

function defineExport<T>(def: ExportDef<T>): ErasedExportDef {
  return def as unknown as ErasedExportDef
}

/** 取某个实体在当前语言下的列定义 */
export function resolveColumns<T>(
  columns: ExportDef<T>['columns'],
  isEn: boolean,
): readonly ExportColumn<T>[] {
  return typeof columns === 'function' ? columns(isEn) : columns
}

export const EXPORT_REGISTRY: Record<string, ErasedExportDef> = {
  'product-templates': defineExport({
    columns: PRODUCT_TEMPLATE_EXPORT_COLUMNS,
    load: loadProductTemplatesForExport,
  }),
  customers: defineExport({
    columns: (isEn) => (isEn ? CUSTOMER_EXPORT_COLUMNS_EN : CUSTOMER_EXPORT_COLUMNS),
    load: loadCustomersForExport,
  }),
  'purchase-orders': defineExport({
    columns: (isEn) => purchaseOrderExportColumns(isEn),
    load: loadPurchaseOrdersForExport,
  }),
  // 报价单与销售单是同一个实体（Order）的两个状态视图，共用一份列定义与取数
  orders: defineExport({
    columns: (isEn) => orderExportColumns(isEn),
    load: loadOrdersForExport,
  }),
}
