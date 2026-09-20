/**
 * 时间桶的显示标签
 * ============================================================================
 * 后端把日期维度按 `DATE_TRUNC(interval, col)` 分组，别名是 `<字段>_<粒度>`
 * （见 lib/reports/sql-builder.ts），值是该桶起点的 timestamp。
 * 直接 `String(value)` 印出来是 `2026-08-01T00:00:00.000Z` —— 交叉表的列头上
 * 挤着这么一串，等于没标。这里把它翻成人能读的月/周/季/年。
 *
 * ⛔ 一律按 **UTC** 取年月日。`DATE_TRUNC` 的结果在库里是不带时区的墙上时间，
 * 用本地时区格式化的话，都柏林 10 月底之前是 UTC+1，`2026-08-01T00:00:00Z`
 * 会被读成 7 月 31 日 —— 整列月份标签集体往前串一个月，而数字是对的，
 * 于是看上去像是"8 月的钱记到了 7 月"。（analytics 侧踩过同一个坑，见
 * docs 里 20260806 的时区口径修正。）
 */
import type { DateInterval } from './types'

/** 时间桶的稳定 key：同一个桶在任何浏览器/时区下都得到同一个串 */
export function bucketKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const d = new Date(value as string | Date)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toISOString()
}

const MONTH_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** ISO 周号（周一为一周之始），与 lib/analytics/pivot.ts 的周维度同一套算法 */
function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/**
 * 把时间桶的取值翻成显示标签。
 * 取不出日期（NULL / 空串 / 非法值）时回落成 `—`，不要印 `Invalid Date`。
 */
export function bucketLabel(value: unknown, interval: DateInterval, isEn: boolean): string {
  if (value === null || value === undefined || value === '') return '—'
  const d = new Date(value as string | Date)
  if (Number.isNaN(d.getTime())) return String(value)

  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()          // 0-based
  const day = d.getUTCDate()
  const pad = (n: number) => String(n).padStart(2, '0')

  switch (interval) {
    case 'year':
      return isEn ? String(y) : `${y} 年`
    case 'quarter': {
      const q = Math.floor(m / 3) + 1
      return isEn ? `Q${q} ${y}` : `${y} 年 Q${q}`
    }
    case 'month':
      return isEn ? `${MONTH_EN[m]} ${y}` : `${y} 年 ${m + 1} 月`
    case 'week': {
      const w = isoWeekNumber(d)
      return isEn ? `W${pad(w)} ${y}` : `${y} 年第 ${pad(w)} 周`
    }
    case 'day':
      return `${y}-${pad(m + 1)}-${pad(day)}`
  }
}

/** 短标签：交叉表列头空间紧张时用（同年就不重复印年份） */
export function bucketLabelShort(value: unknown, interval: DateInterval, isEn: boolean, sameYear: boolean): string {
  if (!sameYear || interval === 'year') return bucketLabel(value, interval, isEn)
  if (value === null || value === undefined || value === '') return '—'
  const d = new Date(value as string | Date)
  if (Number.isNaN(d.getTime())) return String(value)

  const m = d.getUTCMonth()
  switch (interval) {
    case 'month':
      return isEn ? MONTH_EN[m] : `${m + 1} 月`
    case 'quarter':
      return `Q${Math.floor(m / 3) + 1}`
    default:
      return bucketLabel(value, interval, isEn)
  }
}

/** 这批时间桶是否都落在同一年 —— 决定列头用长标签还是短标签 */
export function allSameYear(values: unknown[]): boolean {
  const years = new Set<number>()
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue
    const d = new Date(v as string | Date)
    if (Number.isNaN(d.getTime())) continue
    years.add(d.getUTCFullYear())
  }
  return years.size <= 1
}
