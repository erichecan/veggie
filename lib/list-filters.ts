/**
 * lib/list-filters.ts
 * 报价单/销售单列表页共用的分面搜索 + 时间快捷筛选工具。
 * 后端 /api/orders 已支持对应的 f_* / search / dateField+fromDate/toDate 参数。
 */

export interface Facet {
  /** 维度 key：all/code/customer/salesman/product/driver */
  key: string
  /** chip 上显示的维度名 */
  label: string
  /** 关键词 */
  value: string
}

/** 分面下拉可选维度（顺序即下拉顺序，第一项为默认高亮）。 */
export const ORDER_FACET_FIELDS: { key: string; label: string }[] = [
  { key: 'all',      label: '全部' },
  { key: 'code',     label: '单号' },
  { key: 'customer', label: '客户' },
  { key: 'salesman', label: '销售' },
  { key: 'product',  label: '产品' },
  { key: 'driver',   label: '司机' },
]

/** facet key → /api/orders query 参数名。'all' 走通用模糊 search(客户名/单号)。 */
export function facetParamName(key: string): string {
  if (key === 'all') return 'search'
  return `f_${key}`
}

/** 把 facet 列表写进 URLSearchParams（同一维度取最后一个值）。 */
export function applyFacets(params: URLSearchParams, facets: Facet[]): void {
  for (const f of facets) {
    const v = f.value.trim()
    if (v) params.set(facetParamName(f.key), v)
  }
}

export const TIME_QUICK_OPTIONS: { value: string; label: string }[] = [
  { value: 'today',     label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
]

export const TIME_QUICK_LABEL: Record<string, string> = Object.fromEntries(
  TIME_QUICK_OPTIONS.map(o => [o.value, o.label]),
)

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 周一为一周起点，返回给定日期所在周的周一。 */
function mondayOf(d: Date): Date {
  const r = new Date(d)
  const day = (r.getDay() + 6) % 7 // 周一=0 ... 周日=6
  r.setDate(r.getDate() - day)
  return r
}

/** 计算时间快捷区间 [from, to]（本地日期 yyyy-mm-dd），无匹配返回 null。 */
export function computeTimeRange(key: string, now: Date = new Date()): { from: string; to: string } | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (key) {
    case 'today':
      return { from: ymd(today), to: ymd(today) }
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1)
      return { from: ymd(y), to: ymd(y) }
    }
    case 'this_week': {
      const mon = mondayOf(today)
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6)
      return { from: ymd(mon), to: ymd(sun) }
    }
    case 'last_week': {
      const mon = mondayOf(today); mon.setDate(mon.getDate() - 7)
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6)
      return { from: ymd(mon), to: ymd(sun) }
    }
    default:
      return null
  }
}
