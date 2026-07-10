/**
 * 日期格式化工具函数
 * 统一使用爱尔兰格式：24/04/2025 Thu
 *
 * 字符串版（formatDateWithDay 等）适合 CSV 导出 / HTML 打印模板等纯文本场景；
 * UI 渲染时优先使用 components/shared/date-with-day.tsx 中的 React 组件，
 * 它会按星期几给出加粗+不同颜色的样式。
 */

export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

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
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`
}

/**
 * 将日期格式化为 "2025-04-24 14:30" 格式（含时分+星期）
 */
export function formatDateTimeShort(date: Date | string | number | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const day = DAY_ABBR[d.getDay()]
  return `${dd}/${mm}/${yyyy} ${day} ${hh}:${min}`
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
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const idx = d.getDay()
  return `${dd}/${mm}/${yyyy} <strong style="color:${DAY_COLORS[idx]}">${DAY_ABBR[idx]}</strong> ${hh}:${min}`
}
