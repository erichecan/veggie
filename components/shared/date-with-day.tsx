/**
 * 统一的日期显示组件：日期 + 加粗的星期缩写（按 7 天着色）
 *
 * 默认输出： 24/04/2025 <strong style="color:#9333ea">Thu</strong>
 *
 * - <DateWithDay date={...} /> ：DD/MM/YYYY Day
 * - <DateTimeShort date={...} />：DD/MM/YYYY Day HH:mm
 *
 * 颜色映射来自 lib/format-date.ts 的 DAY_COLORS：
 *   Sun 红 / Mon 蓝 / Tue 绿 / Wed 橙 / Thu 紫 / Fri 粉 / Sat 青
 */
import { DAY_ABBR, DAY_COLORS } from '@/lib/format-date'

type DateInput = Date | string | number | null | undefined

interface Props {
  date: DateInput
  className?: string
  /** 占位符（无日期时显示），默认 — */
  fallback?: string
}

function toDate(date: DateInput): Date | null {
  if (!date) return null
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return null
  return d
}

export function DateWithDay({ date, className, fallback = '—' }: Props) {
  const d = toDate(date)
  if (!d) return <span className={className}>{fallback}</span>
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const idx = d.getDay()
  return (
    <span className={className}>
      {dd}/{mm}/{yyyy}{' '}
      <strong style={{ color: DAY_COLORS[idx], fontWeight: 700 }}>{DAY_ABBR[idx]}</strong>
    </span>
  )
}

export function DateTimeShort({ date, className, fallback = '—' }: Props) {
  const d = toDate(date)
  if (!d) return <span className={className}>{fallback}</span>
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const idx = d.getDay()
  return (
    <span className={className}>
      {dd}/{mm}/{yyyy}{' '}
      <strong style={{ color: DAY_COLORS[idx], fontWeight: 700 }}>{DAY_ABBR[idx]}</strong>{' '}
      {hh}:{min}
    </span>
  )
}
