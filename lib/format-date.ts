/**
 * 日期格式化工具函数
 * 统一使用爱尔兰格式：24/04/2025 Thu
 *
 * 字符串版（formatDateWithDay 等）适合 CSV 导出 / HTML 打印模板等纯文本场景；
 * UI 渲染时优先使用 components/shared/date-with-day.tsx 中的 React 组件，
 * 它会按星期几给出加粗+不同颜色的样式。
 */
import { BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'

export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * 把 Date 拆成它在**业务时区**（都柏林）下的年/月/日/时/分/星期几。
 * 时间戳类字段（createdAt/printedAt 等，真有"几点几分"含义）必须按业务时区展示，
 * 不能按查看者浏览器本地时区——否则同一条记录在都柏林/北美设备上会显示成不同的
 * 日期和时间（同客户列表 20260905 修过的那个坑，见 customer-list-sort-filter-tz-bug 记忆）。
 */
function zonedDateTimeParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return {
    year: g('year'),
    month: g('month'),
    day: g('day'),
    // hour12:false 在午夜偶发返回 "24" 而非 "00"，取模纠正
    hour: String(Number(g('hour')) % 24).padStart(2, '0'),
    minute: g('minute'),
    dayIdx: DAY_ABBR.indexOf(g('weekday') as typeof DAY_ABBR[number]),
  }
}

/** 7 天对应的颜色（周日→周六） */
export const DAY_COLORS = [
  '#dc2626', // Sun - red
  '#2563eb', // Mon - blue
  '#16a34a', // Tue - green
  '#ea580c', // Wed - orange
  '#9333ea', // Thu - purple
  '#db2777', // Fri - pink
  '#0891b2', // Sat - teal
] as const

export function getDayColor(dayIndex: number): string {
  return DAY_COLORS[dayIndex] ?? '#6b7280'
}

/**
 * 将日期格式化为 "2025-04-24 Thu" 格式
 * @param date - Date 对象、ISO 字符串或时间戳
 * @returns 格式化后的字符串，如 "2025-04-24 Thu"
 *
 * 用 UTC getter，不用本地时区 getter：deliveryDate/waveDate 这类"纯日期"字段存的是
 * UTC 零点，没有"几点"的含义，本该按 UTC 日历日显示；用本地时区拆解在时区落后 UTC
 * 的机器上(如美东)会把 07-06 显示成 07-05——2026-07-10 的"销售单和调度台订单数对
 * 不上"就是这个 bug 造成的(其实数量一致，只是显示的日期整体错了一天)。
 */
export function formatDateWithDay(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const day = DAY_ABBR[d.getUTCDay()]
  return `${dd}/${mm}/${yyyy} ${day}`
}

/**
 * 将日期格式化为 "24/04/2025" 格式（仅日期，不含星期）。同上用 UTC getter。
 */
export function formatDateOnly(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy}`
}

/**
 * 将日期格式化为 "24/04/2025 14:30" 格式（含时分，不带星期）
 * 全站时间戳类字段（订单流水、发票详情、打印时间等）的统一格式，SSOT。
 */
export function formatDateTime(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const { year, month, day, hour, minute } = zonedDateTimeParts(d)
  return `${day}/${month}/${year} ${hour}:${minute}`
}

/**
 * 将日期格式化为 "2025-04-24 14:30" 格式（含时分+星期）
 */
export function formatDateTimeShort(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const { year, month, day, hour, minute, dayIdx } = zonedDateTimeParts(d)
  return `${day}/${month}/${year} ${DAY_ABBR[dayIdx]} ${hour}:${minute}`
}

/**
 * HTML 版：返回带 <strong> + 颜色样式的星期几片段
 * 用于打印模板等只接受字符串的场景。同上，纯日期字段用 UTC getter。
 */
export function formatDateWithDayHtml(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const idx = d.getUTCDay()
  return `${dd}/${mm}/${yyyy} <strong style="color:${DAY_COLORS[idx]}">${DAY_ABBR[idx]}</strong>`
}

export function formatDateTimeShortHtml(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const { year, month, day, hour, minute, dayIdx } = zonedDateTimeParts(d)
  return `${day}/${month}/${year} <strong style="color:${DAY_COLORS[dayIdx]}">${DAY_ABBR[dayIdx]}</strong> ${hour}:${minute}`
}
