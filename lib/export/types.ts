/**
 * 导出列定义 —— 服务端导出路由与浏览器端本地导出**共用同一份**。
 * ============================================================================
 * 这是「导出的和屏幕上不一样」在结构上不可能发生的那个保证：
 * 列表页是服务端分页的，导出走 /api/export/<entity>；列表页是客户端筛选的，
 * 导出在浏览器里把屏幕上的 rows 转 CSV —— 两条路读的是同一份列定义。
 *
 * ⛔ get() 必须是纯函数：不得引用 Prisma、React、DOM、locale 之外的运行时状态。
 *    一旦某个 get() 依赖了只有服务端才有的东西，这份定义就没法两端共用，
 *    页面只能再抄一份格式化逻辑，两边就开始分叉了。
 */

export interface ExportColumn<T> {
  /**
   * 稳定字段标识（不随 locale 变化），用于字段勾选导出 UI 与 ?fields= 参数。
   * 同一实体内必须唯一。⛔ 不要用 header 当标识——它会随 isEn 切换成不同字符串。
   */
  key: string
  /** 中文表头 */
  header: string
  /** 英文表头，不写则回落到 header */
  headerEn?: string
  get: (row: T) => unknown
}

export function exportHeaders<T>(columns: readonly ExportColumn<T>[], isEn: boolean): string[] {
  return columns.map(c => (isEn ? (c.headerEn ?? c.header) : c.header))
}

export function exportRows<T>(columns: readonly ExportColumn<T>[], rows: readonly T[]): unknown[][] {
  return rows.map(row => columns.map(c => c.get(row)))
}

/** 按 ?fields=key1,key2 过滤列，保持原始列顺序；未传或全部无效时原样返回全部列 */
export function filterColumnsByKeys<T>(
  columns: readonly ExportColumn<T>[],
  keys: readonly string[] | null | undefined,
): readonly ExportColumn<T>[] {
  if (!keys || keys.length === 0) return columns
  const wanted = new Set(keys)
  const filtered = columns.filter(c => wanted.has(c.key))
  return filtered.length > 0 ? filtered : columns
}
