/**
 * 商品详情页"上一个/下一个"翻页用的临时导航列表（20261001）。
 * ============================================================================
 * 列表页点进某一行前，把当前这一页(已排序/已筛选)的商品 id 顺序存一份到
 * sessionStorage，详情页读出来算"我在第几个、上一个/下一个是谁"。
 *
 * 范围限定在"列表页当前加载的这一页"（最多 pageSize 条），不是全部筛选结果——
 * 那需要服务端再开一个"给定 id 查它在结果集里第几个"的接口，这次不做；
 * 分页(50/页)以内翻页已经覆盖了"看完这页接着看下一个"的日常场景。
 */

const PRODUCT_NAV_LIST_STORAGE_KEY = 'products-nav-list-v1'

export function writeProductNavList(ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(PRODUCT_NAV_LIST_STORAGE_KEY, JSON.stringify(ids))
  } catch { /* 隐私模式/存储禁用/已满——丢了就丢了，不是关键功能 */ }
}

export function readProductNavList(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(PRODUCT_NAV_LIST_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
