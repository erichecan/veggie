'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'

interface Props<C extends { id: string; name: string; city?: string | null }> {
  value: string
  onChange: (v: string) => void
  onSelect: (c: C) => void
  excludeIds?: string[]
  placeholder?: string
  inputClassName?: string
  maxResults?: number
}

export default function CustomerSearchInput<
  C extends { id: string; name: string; city?: string | null }
>({
  value,
  onChange,
  onSelect,
  excludeIds = [],
  placeholder = '搜索客户…',
  inputClassName,
  maxResults = 12,
}: Props<C>) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [results, setResults] = useState<C[]>([])
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = value.trim()
    if (!q) { setResults([]); setLoading(false); return }
    setLoading(true)
    debounceRef.current = setTimeout(() => {
      apiGet<C[]>(`/api/customers?search=${encodeURIComponent(q)}&slim=1`)
        .then(d => setResults(Array.isArray(d) ? d.slice(0, maxResults) : []))
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [value, maxResults])

  const filtered = useMemo(() => results.filter(c => !excludeIds.includes(c.id)), [results, excludeIds])

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  function select(c: C) {
    onSelect(c)
    onChange('')
    setResults([])
    setOpen(false)
    setHighlight(-1)
  }

  const showDropdown = open && (loading || filtered.length > 0)

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        className={inputClassName}
        onChange={e => { onChange(e.target.value); setOpen(true); setHighlight(-1) }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); setHighlight(-1); return }
          if (!open || filtered.length === 0) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter') {
            e.preventDefault()
            const idx = highlight >= 0 ? highlight : 0
            if (filtered[idx]) select(filtered[idx])
          }
        }}
      />
      {showDropdown && (
        <div className="absolute z-50 mt-1 left-0 bg-white border border-gray-200 rounded shadow-lg min-w-[220px] max-h-52 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-xs text-gray-400">搜索中…</div>}
          {!loading && filtered.map((c, idx) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={() => select(c)}
              onMouseEnter={() => setHighlight(idx)}
              className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === highlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
            >
              <span className="font-medium">{c.name}</span>
              {c.city && <span className="ml-2 text-xs text-gray-400">{c.city}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
