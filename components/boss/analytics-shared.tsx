'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

/** 金额格式化（欧元，两位小数，不加千分位）— SSOT: lib/format-money.ts */
export { eur } from '@/lib/format-money'

export interface DateRange { from: string; to: string }

const dayKey = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function defaultRange(days = 30): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - days + 1)
  return { from: dayKey(from), to: dayKey(to) }
}

const PRESETS_ZH: Array<{ label: string; days: number }> = [
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
]
const PRESETS_EN: Array<{ label: string; days: number }> = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

/** 分析页共用的日期范围选择条（含快捷预设） */
export function DateRangeBar({ value, onChange }: {
  value: DateRange
  onChange: (r: DateRange) => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const PRESETS = isEn ? PRESETS_EN : PRESETS_ZH
  const [local, setLocal] = useState(value)
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {PRESETS.map((preset) => (
        <button
          key={preset.days}
          className="border rounded px-2.5 py-1 text-gray-600 hover:bg-gray-50"
          onClick={() => { const r = defaultRange(preset.days); setLocal(r); onChange(r) }}
        >
          {preset.label}
        </button>
      ))}
      <input
        type="date" value={local.from}
        onChange={(e) => setLocal((prev) => ({ ...prev, from: e.target.value }))}
        className="border rounded px-2 py-1"
      />
      <span className="text-gray-400">→</span>
      <input
        type="date" value={local.to}
        onChange={(e) => setLocal((prev) => ({ ...prev, to: e.target.value }))}
        className="border rounded px-2 py-1"
      />
      <button
        className="border rounded px-3 py-1 text-white"
        style={{ backgroundColor: '#875A7B' }}
        onClick={() => onChange(local)}
      >
        {isEn ? 'Search' : '查询'}
      </button>
    </div>
  )
}
