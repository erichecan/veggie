'use client'
import { useMemo, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { rankByRelevance } from '@/lib/search-rank'

interface Props<P extends { id: string; name: string; internalRef?: string | null; category?: string | null; qtyOnHand?: number | null }> {
  value: string
  onChange: (v: string) => void
  onSelect: (p: P) => void
  products: P[]
  placeholder?: string
  inputClassName?: string
  showAtp?: boolean
  portalDropdown?: boolean
  maxResults?: number
  showOnEmptyQuery?: boolean
  externalRef?: React.RefObject<HTMLInputElement | null>
  /** Tab 键选中当前高亮/首个匹配项，无匹配则照常跳到下一个控件（默认 false，保持原有 Tab=跳过行为） */
  selectOnTab?: boolean
}

export default function ProductSearchInput<
  P extends { id: string; name: string; internalRef?: string | null; category?: string | null; qtyOnHand?: number | null }
>({
  value,
  onChange,
  onSelect,
  products,
  placeholder = 'Search products…',
  inputClassName,
  showAtp = false,
  portalDropdown = false,
  maxResults = 20,
  showOnEmptyQuery = true,
  externalRef,
  selectOnTab = false,
}: Props<P>) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const localInputRef = useRef<HTMLInputElement>(null)
  const inputRef = (externalRef ?? localInputRef) as React.RefObject<HTMLInputElement | null>
  const containerRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!showOnEmptyQuery && !value.trim()) return []
    return rankByRelevance(products, value, p => [p.name, p.internalRef]).slice(0, maxResults)
  }, [products, value, showOnEmptyQuery, maxResults])

  function updateRect() {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect()
      setRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width })
    }
  }

  function select(p: P) {
    onSelect(p)
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

  const showDropdown = open && filtered.length > 0

  const dropdownItems = filtered.map((p, idx) => (
    <button
      key={p.id}
      type="button"
      onMouseDown={() => { select(p); setHighlight(-1) }}
      onMouseEnter={() => setHighlight(idx)}
      className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === highlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
    >
      <span className="font-medium">{p.name}</span>
      {p.internalRef && <span className="ml-2 text-[10px] text-gray-400">[{p.internalRef}]</span>}
      {p.category && <span className="ml-2 text-xs text-gray-400">{p.category}</span>}
      {showAtp && p.qtyOnHand != null && (
        <span className={`ml-2 text-xs ${Number(p.qtyOnHand) > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          ATP: {Number(p.qtyOnHand).toFixed(0)}
        </span>
      )}
    </button>
  ))

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        className={inputClassName}
        onChange={e => {
          onChange(e.target.value)
          setHighlight(-1)
          setOpen(true)
          if (portalDropdown) updateRect()
        }}
        onFocus={() => {
          setOpen(true)
          if (portalDropdown) updateRect()
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); setHighlight(-1); return }
          if (e.key === 'Tab') {
            if (selectOnTab && open && filtered.length > 0) {
              select(filtered[highlight >= 0 ? highlight : 0])
            } else {
              setOpen(false)
            }
            return
          }
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
      {showDropdown && !portalDropdown && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-white border border-gray-200 rounded shadow-lg max-h-52 overflow-y-auto">
          {dropdownItems}
        </div>
      )}
      {showDropdown && portalDropdown && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={portalRef}
          style={{ position: 'absolute', top: rect.top + 2, left: rect.left, width: Math.max(rect.width, 288), zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded shadow-lg max-h-52 overflow-y-auto"
        >
          {dropdownItems}
        </div>,
        document.body,
      )}
    </div>
  )
}
