'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { rankByRelevance } from '@/lib/search-rank'
import type { Customer } from '@/lib/types'

const PURPLE = '#875A7B'

/**
 * 订单/报价单编辑页的「换客户」下拉（20260918）。
 *
 * 交互与录单页 place-order 的客户下拉一致（搜索 + 上下键 + 回车 + Esc + 点外面收起），
 * 两个编辑页共用这一份，不再各抄一遍。选中后的联动（带出价格表/账期/业务员、按新客户
 * 重新询价）由调用方在 onSelect 里做，见 lib/order-customer-switch.ts。
 */
export default function CustomerPickerInline({
  customers,
  selectedId,
  onSelect,
  isEn,
  disabled = false,
  disabledHint,
}: {
  customers: Customer[]
  selectedId: string
  onSelect: (c: Customer) => void
  isEn: boolean
  /** 已进入波次/已开票等不允许换客户的单据：只读展示，并说明为什么 */
  disabled?: boolean
  disabledHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () => rankByRelevance(customers, search, c => c.name),
    [customers, search],
  )
  const selected = customers.find(c => c.id === selectedId) ?? null

  useEffect(() => {
    function onMouse(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouse)
    return () => document.removeEventListener('mousedown', onMouse)
  }, [])

  function pick(c: Customer) {
    setOpen(false)
    setSearch('')
    if (c.id !== selectedId) onSelect(c)
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[highlight]) pick(filtered[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  if (disabled) {
    return (
      <div>
        <div style={{ color: PURPLE }} className="font-medium">{selected?.name ?? '—'}</div>
        {disabledHint && <div className="text-xs text-gray-400 mt-0.5">{disabledHint}</div>}
      </div>
    )
  }

  return (
    <div ref={boxRef} className="relative" onKeyDown={onKey}>
      <div
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        className="border border-amber-400 rounded px-2 py-1 text-sm flex items-center justify-between cursor-pointer bg-white min-h-[30px] focus:outline-none focus:ring-2 focus:ring-amber-300"
      >
        <span className={selected ? 'font-medium' : 'text-gray-400'} style={selected ? { color: PURPLE } : undefined}>
          {selected ? selected.name : (isEn ? 'Search customer…' : '搜索客户…')}
        </span>
        <span className="text-gray-400 text-xs ml-2">▾</span>
      </div>
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded shadow-lg">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setHighlight(0) }}
              placeholder={isEn ? 'Search customer…' : '搜索客户…'}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-400 text-center">{isEn ? 'No matching customers' : '没有匹配客户'}</div>
            ) : (
              filtered.map((c, idx) => (
                <div
                  key={c.id}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => pick(c)}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-[#875A7B]/20 ${
                    idx === highlight ? 'bg-[#875A7B]/20' : ''
                  } ${c.id === selectedId ? 'text-[#875A7B] font-medium' : 'text-gray-700'}`}
                >
                  {c.name}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
