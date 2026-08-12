/**
 * 打印内容筛选（台账 D3）
 * ---------------------------------------------------------------------------
 * 需求要的三个维度是「客户 / 线路 / 商品」：
 *   · 线路 —— 由既有的 waveIds / driverSlotId / batchLabel 选择器承担（见 dispatch-loader），
 *             它决定「打哪几趟车」，是取数范围本身；
 *   · 客户 —— 订单级：这一批里只留这几家的单；
 *   · 商品 —— 行级：只留这几个商品的行，行被留空的订单整单不打。
 * 本模块只管后两维，因为它们是「同一批波次里再挑一部分」，与「挑哪些波次」不是一回事。
 *
 * ⚠️ 本模块必须是纯函数，且服务端加载器与前端预览**共用同一段代码**。
 * 「筛选结果条数与预览一致」这条验收标准是靠共用实现保证的，
 * 不是靠两边各写一遍再指望它们凑巧一致 —— 这个项目已经在
 * 「显示态与写入态各算一遍」上栽过（司机 slot 分叉、税率量纲）。
 */

export interface PrintContentFilter {
  /** 客户 id 白名单；空/缺省 = 不按客户筛 */
  customerIds?: string[] | null
  /** 商品 id 白名单；空/缺省 = 不按商品筛 */
  productIds?: string[] | null
}

interface FilterableLine {
  productId: string
}

interface FilterableOrder<L extends FilterableLine> {
  customerId: string
  lines: L[]
}

export interface NormalizedPrintFilter {
  customerIds: Set<string>
  productIds: Set<string>
}

export function normalizePrintFilter(filter: PrintContentFilter | null | undefined): NormalizedPrintFilter {
  return {
    customerIds: new Set((filter?.customerIds ?? []).filter(Boolean)),
    productIds: new Set((filter?.productIds ?? []).filter(Boolean)),
  }
}

/** 是否有任何内容筛选生效（决定是否要在纸面提示「本单据只是全量的一部分」） */
export function hasContentFilter(filter: PrintContentFilter | null | undefined): boolean {
  const n = normalizePrintFilter(filter)
  return n.customerIds.size > 0 || n.productIds.size > 0
}

/** 行级：只按商品筛。无商品筛选时原样返回（保持引用，避免无谓复制） */
export function filterPrintLines<L extends FilterableLine>(
  lines: L[],
  filter: PrintContentFilter | null | undefined,
): L[] {
  const { productIds } = normalizePrintFilter(filter)
  if (productIds.size === 0) return lines
  return lines.filter(l => productIds.has(l.productId))
}

/**
 * 单张订单是否还留在打印范围内。
 * 商品筛选下「这单一行都不剩」= 这单与所选商品无关，整单不打；
 * 没有行数据的历史订单（lines 为空）在商品筛选下同样打不出来 ——
 * 证明不了它含这个商品，宁可不打也不要打出一张空单。
 */
export function keepPrintOrder<L extends FilterableLine>(
  order: FilterableOrder<L>,
  filter: PrintContentFilter | null | undefined,
): boolean {
  const { customerIds, productIds } = normalizePrintFilter(filter)
  if (customerIds.size > 0 && !customerIds.has(order.customerId)) return false
  if (productIds.size > 0 && filterPrintLines(order.lines, filter).length === 0) return false
  return true
}

/**
 * 两维合并应用：先按客户砍订单，再按商品砍行，行光了的订单一并砍掉。
 * 返回的订单在商品筛选生效时是**新对象**（lines 被替换），调用方拿到后
 * 需要重算与行相关的汇总数（如 totalAmount）—— 汇总单读的是订单级
 * totalAmount，不重算就会印出「只有 2 行、金额却是全单」的自相矛盾单据。
 */
export function applyPrintContentFilter<L extends FilterableLine, O extends FilterableOrder<L>>(
  orders: O[],
  filter: PrintContentFilter | null | undefined,
): O[] {
  if (!hasContentFilter(filter)) return orders
  const out: O[] = []
  for (const o of orders) {
    if (!keepPrintOrder(o, filter)) continue
    const lines = filterPrintLines(o.lines, filter)
    out.push(lines === o.lines ? o : { ...o, lines })
  }
  return out
}

// ─── 查询参数编解码（三个打印接口 + 三个 URL 构造器共用） ─────────────────────

export function parseIdListParam(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

export function appendPrintFilterParams(
  params: URLSearchParams,
  filter: PrintContentFilter | null | undefined,
): void {
  const customerIds = (filter?.customerIds ?? []).filter(Boolean)
  const productIds = (filter?.productIds ?? []).filter(Boolean)
  if (customerIds.length > 0) params.set('customerIds', customerIds.join(','))
  if (productIds.length > 0) params.set('productIds', productIds.join(','))
}

/** 纸面提示语：印出来的是全量的一部分，必须说清楚，否则仓库/客户会当成全部 */
export function describePrintFilter(
  filter: PrintContentFilter | null | undefined,
  counts: { customers?: number; products?: number },
): string | null {
  if (!hasContentFilter(filter)) return null
  const n = normalizePrintFilter(filter)
  const parts: string[] = []
  if (n.customerIds.size > 0) parts.push(`客户 ${counts.customers ?? n.customerIds.size} 家`)
  if (n.productIds.size > 0) parts.push(`商品 ${counts.products ?? n.productIds.size} 种`)
  return `本单据已按筛选条件打印（${parts.join(' · ')}），非该批次全部内容。`
}
