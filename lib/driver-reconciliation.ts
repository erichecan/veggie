/**
 * 司机对账状态统计（台账 C10）
 * ============================================================================
 * 财务的那张表：按司机 × 业务日，一眼看出「谁还没报账、谁报了等确认、谁报的对不上」。
 *
 * ## 为什么「未提交」必须从行程派生
 *
 * 只查 `DriverDailyReport` 表，看到的永远是**已经报过账的人**。真正要找的恰恰相反 ——
 * **今天出了车却没报账的那个司机**。他在日报表里一行都没有，查日报表查不出来。
 * 所以行集是并集：
 *
 *   行集 = { 有行程的 (司机, 业务日) }  ∪  { 有日报的 (司机, 业务日) }
 *
 * 前者少了就漏掉未提交的人；后者少了就漏掉「报了账但当天其实没行程」的异常
 * （申报了现金却查无行程，这行的差异恰恰最该看）。
 *
 * ## 状态与差异是两个维度，不是四选一
 *
 * 需求写的是「未提交 / 待确认 / 已确认 / 有差异」，但**「有差异」与前三个不互斥** ——
 * 一条记录完全可以「已确认，且申报值与系统值对不上」，而那正是财务最该复核的一行。
 * 把它们压成一个枚举，等于让「已确认」这个信息被「有差异」吃掉。
 *
 * 所以这里给两个字段：`status` 走生命周期（未提交/待确认/已确认），
 * `hasDiff` 是横切标记。界面上「有差异」作为一个**筛选**存在，不是第四种状态。
 *
 * ## 系统值从哪来
 *
 * 一律来自 `lib/driver-daily-report.ts` 的 `deriveDailyReportRange` +
 * `diffReport` —— 与司机端那张卡片同一份折叠逻辑（`foldTrips`）。
 * 各写一遍的话，司机看到「对得上」而财务看到「差 50」，两边都说自己没错。
 */
import type { DailyDerived, ReportDiff } from './driver-daily-report'
import { diffReport, derivedKey } from './driver-daily-report'
import { formatDateTime } from './format-date'

export type ReconStatus = 'not_submitted' | 'submitted' | 'confirmed'

export const RECON_STATUS_LABEL: Record<ReconStatus, string> = {
  not_submitted: '未提交',
  submitted: '待确认',
  confirmed: '已确认',
}

/** 界面筛选项：三个生命周期状态 + 横切的「有差异」+ 全部 */
export type ReconFilter = 'all' | ReconStatus | 'has_diff'

export const RECON_FILTER_LABEL: Record<ReconFilter, string> = {
  all: '全部',
  not_submitted: '未提交',
  submitted: '待确认',
  confirmed: '已确认',
  has_diff: '有差异',
}

export interface DeclaredValues {
  cashCollected: number
  orderTotal: number
  returnCount: number
  exchangeCount: number
}

/** 已提交的日报快照（`DriverDailyReport` 的子集，只取对账要用的字段） */
export interface ReportSnapshot extends DeclaredValues {
  id: string
  driverId: string
  /** 业务日，`YYYY-MM-DD` —— date 列不经过 JS Date（C8 踩过） */
  reportDate: string
  status: string
  note: string | null
  submittedAt: string | null
  submittedByName: string | null
  confirmedAt: string | null
  confirmedByName: string | null
}

export interface ReconRow {
  driverId: string
  driverName: string
  date: string
  status: ReconStatus
  /** 申报值；未提交时为 null（**不是 0** —— 「报了 0」和「没报」是两件事） */
  declared: DeclaredValues | null
  system: DailyDerived
  diffs: ReportDiff[]
  hasDiff: boolean
  reportId: string | null
  note: string | null
  submittedByName: string | null
  confirmedAt: string | null
  confirmedByName: string | null
}

const EMPTY_DERIVED: DailyDerived = {
  tripIds: [],
  cashCollected: 0,
  onlineCollected: 0,
  orderTotal: 0,
  returnCount: 0,
  exchangeCount: 0,
  stopCount: 0,
  unsettledTripCount: 0,
}

function statusOf(report: ReportSnapshot | undefined): ReconStatus {
  if (!report) return 'not_submitted'
  return report.status === 'confirmed' ? 'confirmed' : 'submitted'
}

/**
 * 汇总成对账行。**纯函数** —— 接口与测试用的是同一份，不存在「接口算一套、导出算另一套」。
 *
 * @param derived    区间派生结果，键为 `derivedKey(driverId, date)`
 * @param reports    区间内已提交的日报快照
 * @param driverName 司机 id → 姓名。取自 `User`（C6 定的司机身份唯一真相），
 *                   不取 `Trip.driverName` 那份快照 —— 改过名的司机会在表里裂成两行
 */
export function buildReconciliationRows(
  derived: Map<string, DailyDerived>,
  reports: ReportSnapshot[],
  driverName: Map<string, string>,
): ReconRow[] {
  const reportByKey = new Map<string, ReportSnapshot>()
  for (const r of reports) reportByKey.set(derivedKey(r.driverId, r.reportDate), r)

  // 并集：有行程的 ∪ 有日报的。少任何一边都会静默漏行（见文件头）
  const keys = new Set<string>([...derived.keys(), ...reportByKey.keys()])

  const rows: ReconRow[] = []
  for (const key of keys) {
    const sep = key.indexOf('|')
    const driverId = key.slice(0, sep)
    const date = key.slice(sep + 1)

    const system = derived.get(key) ?? EMPTY_DERIVED
    const report = reportByKey.get(key)
    const declared: DeclaredValues | null = report
      ? {
          cashCollected: report.cashCollected,
          orderTotal: report.orderTotal,
          returnCount: report.returnCount,
          exchangeCount: report.exchangeCount,
        }
      : null

    // 未提交的行不算「有差异」—— 没申报值就无从比对。它自己就是一种问题，
    // 归在「未提交」里，混进「有差异」会把两类待办搅在一起
    const diffs = declared ? diffReport(declared, system) : []

    rows.push({
      driverId,
      driverName: driverName.get(driverId) ?? '(已删除账号)',
      date,
      status: statusOf(report),
      declared,
      system,
      diffs,
      hasDiff: diffs.length > 0,
      reportId: report?.id ?? null,
      note: report?.note ?? null,
      submittedByName: report?.submittedByName ?? null,
      confirmedAt: report?.confirmedAt ?? null,
      confirmedByName: report?.confirmedByName ?? null,
    })
  }

  // 日期倒序（最近的在最上面），同日按司机名 —— 财务从今天往回看
  rows.sort((a, b) =>
    a.date === b.date ? a.driverName.localeCompare(b.driverName, 'zh-CN') : b.date.localeCompare(a.date),
  )
  return rows
}

export function filterReconciliationRows(rows: ReconRow[], filter: ReconFilter): ReconRow[] {
  if (filter === 'all') return rows
  if (filter === 'has_diff') return rows.filter(r => r.hasDiff)
  return rows.filter(r => r.status === filter)
}

export interface ReconSummary {
  total: number
  notSubmitted: number
  submitted: number
  confirmed: number
  hasDiff: number
}

/** 各页签的计数。**从同一份 rows 数出来**，不另跑聚合查询 —— 否则角标与表格能对不上 */
export function summarizeReconciliation(rows: ReconRow[]): ReconSummary {
  return {
    total: rows.length,
    notSubmitted: rows.filter(r => r.status === 'not_submitted').length,
    submitted: rows.filter(r => r.status === 'submitted').length,
    confirmed: rows.filter(r => r.status === 'confirmed').length,
    hasDiff: rows.filter(r => r.hasDiff).length,
  }
}

export const RECON_CSV_HEADERS = [
  '业务日', '司机', '状态',
  '申报现金', '系统现金', '现金差异',
  '申报订单额', '系统订单额', '订单额差异',
  '申报退货', '系统退货', '申报换货', '系统换货',
  '行程数', '未交账行程', '提交人', '确认时间', '确认人', '备注',
] as const

/** 未提交的行申报列留空而不是填 0 —— CSV 落到 Excel 里，0 会被当成「报了 0」 */
const blankIfNull = (v: number | null | undefined): number | string =>
  v === null || v === undefined ? '' : v

/**
 * 导出用的二维数组。**入参就是屏幕上那份 `rows`**（已筛选、已排序），
 * 不重新聚合 —— 「导出的和屏幕上不一样」因此在结构上不可能发生（D9 定的做法）。
 */
export function reconciliationCsvRows(rows: ReconRow[]): unknown[][] {
  const diffOf = (r: ReconRow, field: ReportDiff['field']) =>
    r.diffs.find(d => d.field === field)?.diff ?? ''
  return rows.map(r => [
    r.date,
    r.driverName,
    RECON_STATUS_LABEL[r.status] + (r.hasDiff ? '（有差异）' : ''),
    blankIfNull(r.declared?.cashCollected), r.system.cashCollected, diffOf(r, 'cashCollected'),
    blankIfNull(r.declared?.orderTotal), r.system.orderTotal, diffOf(r, 'orderTotal'),
    blankIfNull(r.declared?.returnCount), r.system.returnCount,
    blankIfNull(r.declared?.exchangeCount), r.system.exchangeCount,
    r.system.tripIds.length,
    r.system.unsettledTripCount,
    r.submittedByName ?? '',
    // 走全站统一的时间格式。原样丢 ISO 串的话，财务在 Excel 里看到的是
    // `2026-08-14T03:16:08.508Z` —— 带 Z 的 UTC，跟他手表上的时间差一小时且没人会去换算
    r.confirmedAt ? formatDateTime(r.confirmedAt) : '',
    r.confirmedByName ?? '',
    r.note ?? '',
  ])
}
