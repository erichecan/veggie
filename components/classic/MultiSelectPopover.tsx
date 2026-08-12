'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MultiOption { value: string; label: string }

interface Props {
  /** 按钮上的名词，如「分类」「司机」 */
  label: string
  options: MultiOption[]
  selected: string[]
  onChange: (next: string[]) => void
  searchable?: boolean
  searchPlaceholder?: string
  /** 按钮文案自定义（双语页面用）；不传则用中文默认「全部X」/「X：N 项」 */
  buttonLabel?: (selectedCount: number) => string
}

/**
 * 紧凑的多选下拉：收起时是一个按钮（显示「全部X」或「X：N 项」），
 * 点开是一个带可选搜索框的勾选列表。面板走 portal，避免被父容器 overflow-hidden 裁掉。
 */
export default function MultiSelectPopover({
  label, options, selected, onChange, searchable = false, searchPlaceholder, buttonLabel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter(o => o.label.toLowerCase().includes(q)) : options
  }, [options, query])

  useEffect(() => {
    if (!open) return
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: Math.max(r.width, 240) })
    }
    function onDown(e: MouseEvent) {
      if (!btnRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const selCount = selected.length
  const btnLabel = buttonLabel
    ? buttonLabel(selCount)
    : (selCount === 0 ? `全部${label}` : `${label}：${selCount} 项`)

  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`px-2.5 py-1 text-xs rounded-full border transition-colors inline-flex items-center gap-1 ${selCount > 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#875A7B]'}`}
      >
        {btnLabel}
        <span className="text-[10px] leading-none">▾</span>
      </button>
      {open && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'absolute', top: rect.top + 4, left: rect.left, width: rect.width, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-lg shadow-lg"
        >
          {searchable && (
            <div className="p-2 border-b border-gray-100">
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder ?? '搜索…'}
                className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-[#875A7B]"
              />
            </div>
          )}
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-gray-400">无匹配</div>
            ) : filtered.map(o => {
              const on = selected.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-[#875A7B]/10"
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'bg-[#875A7B] border-[#875A7B] text-white' : 'border-gray-300'}`}>
                    {on && <span className="text-[9px] leading-none">✓</span>}
                  </span>
                  <span className="text-gray-700">{o.label}</span>
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-gray-100 text-xs">
            <span className="text-gray-400">{selCount} 已选</span>
            {selCount > 0 && (
              <button onClick={() => onChange([])} className="text-[#875A7B] hover:underline">清除</button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
