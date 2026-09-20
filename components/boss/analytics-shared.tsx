'use client'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'

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

/** 20260915：销售/采购数据分析扩展新增——产品/客户/供应商多选（或单选）筛选器，
 * 服务端 debounce 搜索，不把全量选项摊开（产品/客户可能上千条）。
 * sales-analysis、procurement-analysis 两个页面共用，交互沿用页面自身已有的
 * "checklist 下拉"范式（Measures/GroupBy 那套），只是加了搜索框和多选。 */
export interface SearchOption { id: string; label: string }

/** 三个选品/选客户/选供应商的 fetchOptions 实现，sales-analysis + procurement-analysis 共用 */
export async function searchProductOptions(q: string): Promise<SearchOption[]> {
  const rows = await apiGet<Array<{ id: string; name: string }>>(`/api/products?slim=1&sellable=1&search=${encodeURIComponent(q)}`)
  return rows.slice(0, 30).map((r) => ({ id: r.id, label: r.name }))
}
/**
 * 采购侧选品。
 *
 * ⛔ 别在采购页复用上面那个：它带 `sellable=1`（`canBeSold`），
 * 而包材、耗材、只进不卖的货是 `canBePurchased && !canBeSold` —— 这些商品的采购金额
 * 会出现在采购分析的表里，却永远筛不出来，而下拉框不会告诉你它少了东西。
 */
export async function searchPurchasableProductOptions(q: string): Promise<SearchOption[]> {
  const rows = await apiGet<Array<{ id: string; name: string }>>(`/api/products?slim=1&purchasable=1&search=${encodeURIComponent(q)}`)
  return rows.slice(0, 30).map((r) => ({ id: r.id, label: r.name }))
}
export async function searchCustomerOptions(q: string): Promise<SearchOption[]> {
  const rows = await apiGet<Array<{ id: string; name: string }>>(`/api/customers?slim=1&search=${encodeURIComponent(q)}`)
  return rows.slice(0, 30).map((r) => ({ id: r.id, label: r.name }))
}
export async function searchSupplierOptions(q: string): Promise<SearchOption[]> {
  const res = await apiGet<{ items: Array<{ id: string; name: string }> }>(`/api/suppliers?q=${encodeURIComponent(q)}&pageSize=30`)
  return res.items.map((r) => ({ id: r.id, label: r.name }))
}

export function SearchSelectDropdown({
  label, selected, onChange, fetchOptions, multiple = true, isEn,
}: {
  label: string
  selected: SearchOption[]
  onChange: (options: SearchOption[]) => void
  fetchOptions: (query: string) => Promise<SearchOption[]>
  multiple?: boolean
  isEn: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOption[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const t = setTimeout(() => {
      fetchOptions(query).then(setOptions).catch(() => setOptions([])).finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  const selectedIds = new Set(selected.map((s) => s.id))

  function toggle(opt: SearchOption) {
    if (multiple) {
      onChange(selectedIds.has(opt.id) ? selected.filter((s) => s.id !== opt.id) : [...selected, opt])
    } else {
      onChange(selectedIds.has(opt.id) ? [] : [opt])
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white max-w-[220px]"
      >
        <span className="truncate">
          {selected.length === 0 ? label : selected.length === 1 ? selected[0].label : `${label} (${selected.length})`}
        </span>
        <span className="text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 w-64 py-1">
          <div className="px-2 pb-1 pt-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isEn ? 'Search…' : '搜索…'}
              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pb-1.5 mb-1 border-b border-gray-100">
              {selected.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded" style={{ background: '#f3eff5', color: PURPLE }}>
                  <span className="max-w-[100px] truncate">{s.label}</span>
                  <button type="button" onClick={() => onChange(selected.filter((x) => x.id !== s.id))} className="hover:opacity-60">✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {loading && <div className="px-4 py-3 text-xs text-gray-400">…</div>}
            {!loading && options.length === 0 && (
              <div className="px-4 py-3 text-xs text-gray-400">{isEn ? 'No match' : '无匹配'}</div>
            )}
            {!loading && options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => toggle(opt)}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
              >
                {selectedIds.has(opt.id) && <span style={{ color: PURPLE }}>✓</span>}
                {!selectedIds.has(opt.id) && <span className="w-4" />}
                <span className="truncate">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
