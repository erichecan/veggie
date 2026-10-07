'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 表格行内编辑用的可搜索下拉（20261007 客户反馈：列表 Edit 模式下改 Salesperson /
 * Pricelist 只能在原生 <select> 里一个个翻，客户上千、销售员几十个时找不到人；
 * 要像 Odoo 的 many2one 一样，直接打字筛选再选）。
 *
 * - 进入编辑态即聚焦输入框，打字按 label 模糊匹配(不区分大小写)
 * - ↑/↓ 循环移动高亮，Enter 选中，Esc 放弃；点外面 = 放弃(不改值)
 * - 选中即提交(onPick)，不需要再按回车/失焦
 *
 * 下拉面板用 position: fixed 按输入框的位置摆，避免被表格外层 overflow 容器裁掉。
 */
export interface InlineSearchOption { value: string; label: string }

interface Props {
  options: InlineSearchOption[]
  value: string
  disabled?: boolean
  placeholder?: string
  emptyText?: string
  onPick: (value: string) => void
  onCancel: () => void
}

export default function InlineSearchSelect({ options, value, disabled, placeholder, emptyText = 'No match', onPick, onCancel }: Props) {
  const current = options.find(o => o.value === value)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(() => Math.max(0, options.findIndex(o => o.value === value)))
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 220) })
  }, [])

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (inputRef.current?.contains(t) || panelRef.current?.contains(t)) return
      onCancel()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onCancel])

  useEffect(() => {
    panelRef.current?.querySelector(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight(h => (h + step + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[highlight]
      if (opt) onPick(opt.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder={current?.label || placeholder}
        onChange={e => { setQuery(e.target.value); setHighlight(0) }}
        onKeyDown={onKeyDown}
        onClick={e => e.stopPropagation()}
        className="w-full h-7 px-1 text-sm border border-[#875A7B] rounded bg-white focus:outline-none placeholder:text-gray-500"
      />
      {rect && (
        <div
          ref={panelRef}
          role="listbox"
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, zIndex: 60 }}
          className="max-h-60 overflow-y-auto bg-white border border-gray-200 rounded shadow-lg py-1 text-sm"
        >
          {filtered.length === 0 && <div className="px-3 py-1.5 text-gray-400">{emptyText}</div>}
          {filtered.map((o, idx) => (
            <div
              key={o.value || '__empty__'}
              data-idx={idx}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setHighlight(idx)}
              onMouseDown={e => { e.preventDefault(); onPick(o.value) }}
              className={`px-3 py-1.5 cursor-pointer truncate ${idx === highlight ? 'bg-[#f3eff5] text-[#6d4a66]' : 'text-gray-700'} ${o.value === value ? 'font-semibold' : ''}`}
            >
              {o.label || <span className="text-gray-400">—</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
