/**
 * 采购单详情页「上一张 / 下一张」的导航上下文 —— 20261013
 * ============================================================================
 * 列表是服务端分页，只记当前页的 id 的话，翻到页尾就走不下去了。这里记的是列表当时的
 * 筛选 + 排序参数(sessionStorage，同一标签页内有效)，详情页拿它去
 * GET /api/purchase-orders?…&idsOnly=1 取整个结果集的 id 顺序。
 */
const STORAGE_KEY = 'purchases-nav-params-v1'

/** 直接打开详情页(没经过列表)时用的默认口径：与列表默认一致，按创建时间倒序 */
export const DEFAULT_PURCHASE_NAV_PARAMS = 'sortField=createdAt&sortDir=desc'

export function writePurchaseNavParams(params: string) {
  try {
    sessionStorage.setItem(STORAGE_KEY, params)
  } catch {}
}

export function readPurchaseNavParams(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
