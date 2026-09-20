'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { rankByRelevance } from '@/lib/search-rank'

interface Props<P extends { id: string; name: string; externalId?: string | null; currency?: string | null }> {
  pricelists: P[]
  excludeIds?: string[]
  onSelect: (p: P) => void
  placeholder?: string
  /** 搜不到时的提示文案 */
  emptyText?: string
  inputClassName?: string
  maxResults?: number
}

export default function PricelistSearchInput<
  P extends { id: string; name: string; externalId?: string | null; currency?: string | null }
>({
  pricelists,
  excludeIds = [],
  onSelect,
  placeholder = 'Search pricelist…',
  emptyText = 'No matching pricelist',
  inputClassName,
  maxResults = 50,
}: Props<P>) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const filtered = useMemo(() => {
    const pool = pricelists.filter(p => !excludeIds.includes(p.id))
    const ranked = rankByRelevance(pool, query, p => [p.name, p.externalId])
    if (ranked.length > 0 || !query.trim()) return ranked.slice(0, maxResults)
    // 整串搜不到时退回「每个词都出现即可」：价格表名普遍是 "Takeaway Pricelist 75"
    // 这种中间夹固定词的格式，用户按 "takeaway 75" 输入时整串 includes 必然落空
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length < 2) return []
    return pool
      .filter(p => {
        const hay = `${p.name} ${p.externalId ?? ''}`.toLowerCase()
        return tokens.every(t => hay.includes(t))
      })
      .slice(0, maxResults)
  }, [pricelists, excludeIds, query, maxResults])

  function updateRect() {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width })
  }

  function select(p: P) {
    onSelect(p)
    setQuery('')
    setOpen(false)
    setHighlight(-1)
  }

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (
        !containerRef.current?.contains(e.target as Node) &&
        !portalRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  useEffect(() => {
    if (highlight >= 0) itemRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const noMatch = open && !!query.trim() && filtered.length === 0
  const showDropdown = open && (filtered.length > 0 || noMatch)

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder}
        className={inputClassName}
        onChange={e => { setQuery(e.target.value); setHighlight(-1); setOpen(true); updateRect() }}
        onFocus={() => { setOpen(true); updateRect() }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); setHighlight(-1); return }
          if (e.key === 'Tab') { setOpen(false); return }
          if (!open || filtered.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight(h => Math.min(h + 1, filtered.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight(h => Math.max(h - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const idx = highlight >= 0 ? highlight : 0
            if (filtered[idx]) select(filtered[idx])
          }
        }}
      />
      {showDropdown && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={portalRef}
          style={{ position: 'absolute', top: rect.top + 2, left: rect.left, width: Math.max(rect.width, 288), zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded shadow-lg max-h-72 overflow-y-auto"
        >
          {noMatch && (
            <div className="px-3 py-2 text-xs text-gray-400">{emptyText}</div>
          )}
          {filtered.map((p, idx) => (
            <button
              key={p.id}
              ref={el => { itemRefs.current[idx] = el }}
              type="button"
              onMouseDown={() => select(p)}
              onMouseEnter={() => setHighlight(idx)}
              className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === highlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
            >
              <span className="font-medium">{p.name}</span>
              {p.currency && <span className="ml-2 text-xs text-gray-400">{p.currency}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
