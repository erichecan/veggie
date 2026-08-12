/**
 * 收货 ↔ 采购单的关联与到货时效（台账 E6）
 * ============================================================================
 * 三件事：
 *   1. 预计到货日 vs 实际到货日的偏差 —— 收货现场就要看得见，事后才能算准时率；
 *   2. 哪些入库**没有采购单据** —— `GoodsReceipt.purchaseOrderId` 是非空外键，
 *      走收货工作台的收货必然挂着采购单，所以「未关联」不可能出现在收货单表里。
 *      真正会漏的是**绕过收货单直接进库存的那些流水**（手工调整、导入、盘盈），
 *      货实际进来了却没有任何采购依据 —— 这才是需求要识别的东西；
 *   3. 上面两条都是纯函数，服务端接口与页面共用，避免两处各判一套。
 */

/**
 * 入库来源里，**有据可查**的那些：要么来自收货单，要么是销售侧的退回/释放。
 * 导出给服务端拼查询条件用 —— 判据只有这一份，不在 SQL 里再抄一遍。
 */
export const ACCOUNTED_IN_SOURCE_LIST = [
  'GOODS_RECEIPT',   // 正常收货
  'RECEIPT_DAMAGE',  // 收货判损（到货那一笔 IN，随后被 SCRAP 抵掉）
  'ORDER',           // 订单减量/删行释放回库
  'RETURN',          // 客退回库
  'RETURN_SCRAP',    // 客退报废（成对流水）
  'CREDIT_NOTE',     // 退货单
] as const

const ACCOUNTED_IN_SOURCES = new Set<string>(ACCOUNTED_IN_SOURCE_LIST)

/**
 * 期初余额（Z5 定的口径：起算日之前的库存作期初、之后严格走流水）。
 * 它确实是「没有采购单的入库」，但那是一次性、有意为之、有明确标记的事件 ——
 * 把它算进「未关联收货」会淹掉真正要看的东西：本地库实测 30 天内
 * **1,583 / 1,650 笔入库都是期初余额**，不排掉的话这块提示永远是一片红，
 * 没人会再看第二眼。按 sourceRef 精确排除，而不是把整个 ADJUSTMENT 类型放行 ——
 * 正数调整恰恰是「悄悄把货塞进库存」最可能的路径，必须留在视野里。
 */
export const OPENING_BALANCE_REFS = ['OPENING-BALANCE'] as const

export interface StockMoveForLinkage {
  type: string
  qty: number
  sourceType?: string | null
  sourceRef?: string | null
}

/**
 * 这笔流水是否属于「货进来了，但没有采购单据」。
 *
 * 判据刻意用**白名单反选**而不是列举可疑来源：将来有人加了新的入库路径却忘了
 * 登记，会自动落进「未关联」被看见 —— 反过来（黑名单）则会静默漏掉。
 */
export function isUnlinkedInbound(m: StockMoveForLinkage): boolean {
  const inbound = m.type === 'IN' || (m.type === 'ADJUSTMENT' && m.qty > 0)
  if (!inbound) return false
  if ((OPENING_BALANCE_REFS as readonly string[]).includes(m.sourceRef ?? '')) return false
  return !ACCOUNTED_IN_SOURCES.has(m.sourceType ?? '')
}

export type ArrivalTiming = 'ON_TIME' | 'EARLY' | 'LATE' | 'UNKNOWN'

export interface ArrivalDelay {
  timing: ArrivalTiming
  /** 实际 − 预计，单位天；正数=迟到，负数=早到。预计日缺失时为 null */
  days: number | null
}

/** 只取日期部分比较：到货时间的「几点」没有意义，差一小时不该被算成迟到一天 */
function toDayNumber(v: Date | string | null | undefined): number | null {
  if (!v) return null
  const s = typeof v === 'string' ? v : v.toISOString()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000
}

/**
 * 预计到货日 vs 实际到货日。
 * 采购单没填预计到货日时返回 UNKNOWN —— 不要拿创建日、也不要拿今天顶替，
 * 那会凭空造出一个「准时率」，比没有更糟。
 */
export function arrivalDelay(
  expected: Date | string | null | undefined,
  actual: Date | string | null | undefined,
): ArrivalDelay {
  const e = toDayNumber(expected)
  const a = toDayNumber(actual)
  if (e === null || a === null) return { timing: 'UNKNOWN', days: null }
  const days = a - e
  return { timing: days === 0 ? 'ON_TIME' : days > 0 ? 'LATE' : 'EARLY', days }
}

/** 给界面用的一句话（中文）。UNKNOWN 时返回 null，让调用方自己决定显示什么 */
export function describeArrivalDelay(d: ArrivalDelay): string | null {
  if (d.timing === 'UNKNOWN' || d.days === null) return null
  if (d.timing === 'ON_TIME') return '按期到货'
  return d.days > 0 ? `迟到 ${d.days} 天` : `提前 ${Math.abs(d.days)} 天`
}

export function describeArrivalDelayEn(d: ArrivalDelay): string | null {
  if (d.timing === 'UNKNOWN' || d.days === null) return null
  if (d.timing === 'ON_TIME') return 'On time'
  return d.days > 0 ? `${d.days} day(s) late` : `${Math.abs(d.days)} day(s) early`
}
