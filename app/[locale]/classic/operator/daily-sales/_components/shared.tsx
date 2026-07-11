'use client'
import { useState, useRef, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { fmtMoney as canonicalFmtMoney } from '@/lib/format-money'

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface CustomerRow { id: string; name: string }
export interface ProductRow { id: string; name: string; category?: string }
export interface CategoryRow { id: string; name: string }
export interface UserRow { id: string; name: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function fmtMoney(n: number): string {
  return canonicalFmtMoney(n)
}

export function fmtWeight(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

// 行税前(未税)金额。OrderLine.subtotal 恒 = unitPrice×orderedQty,本身已经是税前快照
// (SSOT,见 docs/20260701 审计 + lib/order-items.ts orderIncTaxTotal)，直接返回即可——
// 不能再除以 (1+taxRate)，那样会把已经是税前的金额按税率二次打折，导致界面"未税"数字系统性偏小。
export function lineUntax(l: { subtotal: number; taxRate?: number | null }): number {
  return Number(l.subtotal)
}

export function toggleValue<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]
}

// ─── ChipMultiSelect ──────────────────────────────────────────────────────────

interface ChipMultiSelectProps<T extends string | number> {
  label?: string
  options: T[]
  selected: T[]
  onChange: (v: T[]) => void
}

export function ChipMultiSelect<T extends string | number>({
  label, options, selected, onChange,
}: ChipMultiSelectProps<T>) {
  if (options.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {label && <span className="text-xs text-gray-400 mr-0.5">{label}:</span>}
      {options.map(opt => {
        const active = selected.includes(opt)
        return (
          <button
            key={String(opt)}
            onClick={() => onChange(toggleValue(selected, opt))}
            className={`px-2 py-0.5 rounded text-xs border transition-colors ${
              active
                ? 'bg-[#875A7B] text-white border-[#875A7B]'
                : 'bg-white text-gray-600 border-gray-300 hover:border-[#875A7B] hover:text-[#875A7B]'
            }`}
          >
            {String(opt)}
          </button>
        )
      })}
      {selected.length > 0 && (
        <button
          onClick={() => onChange([])}
          className="px-1.5 py-0.5 rounded text-xs text-gray-400 hover:text-red-500"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── InlineSearch ─────────────────────────────────────────────────────────────
// Odoo-style "+ Add a line" inline search component

interface InlineSearchItem { id: string; label: string }

interface InlineSearchProps {
  placeholder?: string
  items: InlineSearchItem[]
  onSelect: (item: InlineSearchItem) => void
  disabled?: boolean
}

export function InlineSearch({ placeholder, items, onSelect, disabled }: InlineSearchProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const resolvedPlaceholder = placeholder ?? (isEn ? '+ Add filter' : '+ 添加筛选项')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = query.length > 0
    ? items.filter(i => i.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12)
    : items.slice(0, 12)

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(f => Math.min(f + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(f => Math.max(f - 1, 0)) }
    if (e.key === 'Enter' && filtered[focused]) {
      onSelect(filtered[focused])
      setOpen(false)
      setQuery('')
    }
    if (e.key === 'Escape') { setOpen(false); setQuery('') }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      {!open ? (
        <button
          disabled={disabled}
          onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
          className="text-xs text-[#875A7B] hover:underline disabled:opacity-40"
        >
          {resolvedPlaceholder}
        </button>
      ) : (
        <div>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setFocused(0) }}
            onKeyDown={handleKeyDown}
            placeholder={isEn ? 'Search...' : '搜索...'}
            className="border border-[#875A7B] rounded px-2 py-0.5 text-xs w-40 focus:outline-none"
          />
          {filtered.length > 0 && (
            <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded shadow-lg min-w-[180px] max-h-64 overflow-y-auto">
              {filtered.map((item, i) => (
                <button
                  key={item.id}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${i === focused ? 'bg-purple-50' : ''}`}
                  onMouseEnter={() => setFocused(i)}
                  onClick={() => { onSelect(item); setOpen(false); setQuery('') }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
