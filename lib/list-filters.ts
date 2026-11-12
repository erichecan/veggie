/**
 * lib/list-filters.ts
 * 报价单/销售单列表页共用的分面搜索 + 时间快捷筛选工具。
 * 后端 /api/orders 已支持对应的 f_* / search / dateField+fromDate/toDate 参数。
 */

export interface Facet {
  /** 维度 key：all/code/customer/salesman/product/category/driver */
  key: string
  /** chip 上显示的维度名 */
  label: string
  /** 关键词 */
  value: string
}

export interface FacetFieldDef {
  key: string
  label: string
  labelEn: string
}

/**
 * facetFields 传给 OdooControlPanel 前必须过一遍这个函数——分面下拉的维度名（全部/名称/城市…）
 * 此前是写死的中文，英文界面下这几个词完全不会跟着切换(20260904 客户反馈"英语状态下出现中文")。
 */
export function localizeFacetFields(fields: FacetFieldDef[], isEn: boolean): { key: string; label: string }[] {
  return fields.map(f => ({ key: f.key, label: isEn ? f.labelEn : f.label }))
}

/** 分面下拉可选维度（顺序即下拉顺序，第一项为默认高亮）。 */
export const ORDER_FACET_FIELDS: FacetFieldDef[] = [
  { key: 'all',      label: '全部',    labelEn: 'All' },
  { key: 'code',     label: '单号',    labelEn: 'Order Ref' },
  { key: 'customer', label: '客户',    labelEn: 'Customer' },
  { key: 'salesman', label: '销售',    labelEn: 'Salesperson' },
  { key: 'product',  label: '产品',    labelEn: 'Product' },
  { key: 'category', label: '产品类目', labelEn: 'Product Category' },
  { key: 'driver',   label: '司机',    labelEn: 'Driver' },
  { key: 'weekday',  label: '交货星期', labelEn: 'Delivery Weekday' },
]

/** 销售单专属的配送波次搜索维度；与 Driver facet 组合可筛选某司机某时段/批次的订单。 */
export const SALES_ORDER_FACET_FIELDS: FacetFieldDef[] = [
  ...ORDER_FACET_FIELDS.filter(field => field.key !== 'all'),
  { key: 'dispatchAssignment', label: '司机 + 批次 + 时段', labelEn: 'Driver + Batch + Shift' },
  { key: 'dispatchBatch', label: '批次/时段', labelEn: 'Batch / Shift' },
  { key: 'dispatchShift', label: '时段', labelEn: 'Shift' },
]

/**
 * 交货星期关键词 → JS Date.getDay() 约定的星期数字(周日=0…周六=6，与 Postgres EXTRACT(DOW) 一致)。
 * 支持英文全称/常见缩写 + 中文"周三/星期三/礼拜三"，不识别返回 null。
 * 不收录单字"一/二/三"——那些是极常见汉字，会把普通关键词搜索误判成星期筛选。
 */
const WEEKDAY_TERMS: Record<string, number> = {
  sun: 0, sunday: 0, '周日': 0, '周天': 0, '星期日': 0, '星期天': 0, '礼拜日': 0, '礼拜天': 0,
  mon: 1, monday: 1, '周一': 1, '星期一': 1, '礼拜一': 1,
  tue: 2, tues: 2, tuesday: 2, '周二': 2, '星期二': 2, '礼拜二': 2,
  wed: 3, weds: 3, wednesday: 3, '周三': 3, '星期三': 3, '礼拜三': 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, '周四': 4, '星期四': 4, '礼拜四': 4,
  fri: 5, friday: 5, '周五': 5, '星期五': 5, '礼拜五': 5,
  sat: 6, saturday: 6, '周六': 6, '星期六': 6, '礼拜六': 6,
}

export function parseWeekday(raw: string): number | null {
  const key = raw.trim().toLowerCase()
  return key in WEEKDAY_TERMS ? WEEKDAY_TERMS[key] : null
}

/**
 * 商品列表页可选维度。对应 /api/products 的 f_* 参数，子句定义见
 * lib/facets/product-templates.ts。
 * 20260825 合表重构：'变体' 维度删除，ProductTemplate 已删，不再有多变体概念。
 */
export const PRODUCT_FACET_FIELDS: FacetFieldDef[] = [
  { key: 'all',         label: '全部',   labelEn: 'All' },
  { key: 'name',        label: '名称',   labelEn: 'Name' },
  { key: 'ref',         label: '内部编号', labelEn: 'Internal Reference' },
  { key: 'category',    label: '类目',   labelEn: 'Category' },
  { key: 'description', label: '描述',   labelEn: 'Description' },
]

/** 客户列表页可选维度，子句定义见 lib/facets/customers.ts。 */
export const CUSTOMER_FACET_FIELDS: FacetFieldDef[] = [
  { key: 'all',      label: '全部',       labelEn: 'All' },
  { key: 'name',     label: '名称',       labelEn: 'Name' },
  { key: 'salesman', label: '业务员',     labelEn: 'Salesperson' },
  { key: 'pricelist',label: '价格表',     labelEn: 'Pricelist' },
]

/** 采购单列表页可选维度，子句定义见 lib/facets/purchase-orders.ts。 */
export const PURCHASE_FACET_FIELDS: FacetFieldDef[] = [
  { key: 'all',             label: '全部',       labelEn: 'All' },
  { key: 'name',            label: '单号',       labelEn: 'PO No.' },
  { key: 'vendorReference', label: '供应商参考号', labelEn: 'Vendor Reference' },
  { key: 'supplier',        label: '供应商',     labelEn: 'Supplier' },
  { key: 'product',         label: '商品',       labelEn: 'Product' },
  { key: 'notes',           label: '采购单备注',  labelEn: 'Order Notes' },
]

/** facet key → /api/orders query 参数名。'all' 走通用模糊 search(客户名/单号)。 */
export function facetParamName(key: string): string {
  if (key === 'all') return 'search'
  return `f_${key}`
}

/**
 * 把 facet 列表写进 URLSearchParams。
 * 同一维度的多个值全部累积（append），后端用 getAll 取出后组成 OR；
 * 不同维度之间由后端 AND。
 */
export function applyFacets(params: URLSearchParams, facets: Facet[]): void {
  const seen = new Set<string>()
  for (const f of facets) {
    const v = f.value.trim()
    if (!v) continue
    const name = facetParamName(f.key)
    const dedupeKey = name + '\u0000' + v.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    params.append(name, v)
  }
}

/**
 * 把搜索框里的一串输入按 " or " 拆成多个关键词。
 *
 * chip 上同维度的多个关键词就是用 "or" 连起来显示的（见 groupFacets），
 * 用户照着这个写法直接在框里输入 "pepper g or scall" 是完全合理的预期
 * —— 20260820 客户正是这么用的，而当时整串被当成一个字面关键词去 like，
 * 于是"搜两样东西"变成"搜一个不存在的名字"。
 *
 * 只认两侧带空白的独立单词 or（大小写不敏感），所以 "Orange"、"Flavour" 这类
 * 含 or 的商品名不受影响。
 */
export function splitOrTerms(input: string): string[] {
  return input.split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean)
}

export interface FacetGroup {
  key: string
  label: string
  /** 该维度下的全部关键词，按加入顺序 */
  values: string[]
  /** chip 上的完整文案，如 "产品: odlum or ketch"；'all' 维度只显示值本身 */
  chipLabel: string
}

/**
 * 把扁平的 facet 列表按维度合并成 chip（Odoo 式：同维度多值挤在一个 chip 里用 or 连接）。
 * 顺序按维度首次出现的先后。
 */
export function groupFacets(facets: Facet[]): FacetGroup[] {
  const order: string[] = []
  const byKey = new Map<string, FacetGroup>()
  for (const f of facets) {
    const v = f.value.trim()
    if (!v) continue
    const g = byKey.get(f.key)
    if (g) { g.values.push(v) } else {
      order.push(f.key)
      byKey.set(f.key, { key: f.key, label: f.label, values: [v], chipLabel: '' })
    }
  }
  return order.map(k => {
    const g = byKey.get(k)!
    const joined = g.values.join(' or ')
    g.chipLabel = g.key === 'all' ? joined : `${g.label}: ${joined}`
    return g
  })
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
