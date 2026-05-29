'use client'
import { useState, useRef, useEffect } from 'react'

interface ActiveFilter {
  label: string
  onRemove: () => void
}

interface FilterOption {
  label: string
  value: string
}

interface ActionItem {
  label: string
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  style?: 'green' | 'red'
}

interface SavedFavourite {
  name: string
  state: Record<string, unknown>
}

interface OdooControlPanelProps {
  breadcrumb?: string[]
  onNew?: () => void
  permanentActions?: ActionItem[]
  actions?: ActionItem[]
  searchValue: string
  onSearch: (v: string) => void
  onSearchSubmit?: () => void
  activeFilters?: ActiveFilter[]
  filterOptions?: FilterOption[]
  groupByOptions?: FilterOption[]
  groupByValue?: string
  onGroupByChange?: (value: string) => void
  onFilterSelect?: (value: string) => void
  onGroupBySelect?: (value: string) => void
  storageKey?: string
  favouriteState?: Record<string, unknown>
  onFavouriteApply?: (state: Record<string, unknown>) => void
  total?: number
  page?: number
  pageSize?: number
  onPageChange?: (p: number) => void
  className?: string
}

function Chevron() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

export default function OdooControlPanel({
  breadcrumb = [],
  onNew,
  permanentActions = [],
  actions = [],
  searchValue,
  onSearch,
  onSearchSubmit,
  activeFilters = [],
  filterOptions = [],
  groupByOptions = [],
  groupByValue = '',
  onGroupByChange,
  onFilterSelect,
  onGroupBySelect,
  storageKey,
  favouriteState,
  onFavouriteApply,
  total = 0,
  page = 1,
  pageSize = 20,
  onPageChange,
  className = '',
}: OdooControlPanelProps) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupByOpen, setGroupByOpen] = useState(false)
  const [favOpen, setFavOpen] = useState(false)
  const [showFavInput, setShowFavInput] = useState(false)
  const [favName, setFavName] = useState('')
  const [savedFavourites, setSavedFavourites] = useState<SavedFavourite[]>([])

  const actionsRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const groupByRef = useRef<HTMLDivElement>(null)
  const favRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!storageKey) return
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setSavedFavourites(JSON.parse(raw) as SavedFavourite[])
    } catch {}
  }, [storageKey])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) setActionsOpen(false)
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
      if (groupByRef.current && !groupByRef.current.contains(e.target as Node)) setGroupByOpen(false)
      if (favRef.current && !favRef.current.contains(e.target as Node)) { setFavOpen(false); setShowFavInput(false) }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function persistFavourites(list: SavedFavourite[]) {
    setSavedFavourites(list)
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(list)) } catch {}
    }
  }

  function saveFavourite() {
    if (!favName.trim() || !storageKey) return
    const next = [...savedFavourites.filter(f => f.name !== favName.trim()), { name: favName.trim(), state: favouriteState ?? {} }]
    persistFavourites(next)
    setFavName('')
    setShowFavInput(false)
    setFavOpen(false)
  }

  function deleteFavourite(name: string) {
    persistFavourites(savedFavourites.filter(f => f.name !== name))
  }

  const hasGroupBy = groupByOptions.length > 0 && (onGroupByChange ?? onGroupBySelect)
  const hasFavourites = !!storageKey

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1

  return (
    <div className={`bg-white border-b border-gray-200 ${className}`}>
      {/* 面包屑 */}
      {breadcrumb.length > 0 && (
        <div className="px-4 pt-3 pb-1 text-sm text-gray-500 flex items-center gap-1">
          {breadcrumb.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300">›</span>}
              <span className={i === breadcrumb.length - 1 ? 'text-gray-800 font-medium' : ''}>
                {crumb}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* 主控制行：左=按钮，右=搜索+筛选+分页 */}
      <div className="px-4 py-2 flex items-center gap-2 min-h-[44px]">

        {/* 左侧：操作按钮组 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onNew && (
            <button
              onClick={onNew}
              className="h-8 px-4 text-sm font-medium rounded border transition-colors"
              style={{ background: '#875A7B', borderColor: '#875A7B', color: 'white' }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = '#7a5070'
                ;(e.currentTarget as HTMLElement).style.borderColor = '#7a5070'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = '#875A7B'
                ;(e.currentTarget as HTMLElement).style.borderColor = '#875A7B'
              }}
            >
              新建
            </button>
          )}

          {permanentActions.map((a, i) => {
            const greenStyle = a.style === 'green'
            const redStyle = a.style === 'red'
            return (
              <button
                key={i}
                onClick={a.disabled ? undefined : a.onClick}
                disabled={a.disabled}
                className="h-8 px-3 text-sm rounded border font-medium transition-colors disabled:cursor-default"
                style={a.primary
                  ? { background: greenStyle ? '#21a67a' : redStyle ? '#dc2626' : '#875A7B', borderColor: greenStyle ? '#21a67a' : redStyle ? '#dc2626' : '#875A7B', color: 'white' }
                  : { background: 'white', borderColor: '#d1d5db', color: '#374151' }}
              >
                {a.label}
              </button>
            )
          })}

          {actions.length > 0 && (
            <div className="relative" ref={actionsRef}>
              <button
                onClick={() => setActionsOpen(v => !v)}
                className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1 transition-colors"
              >
                操作 <Chevron />
              </button>
              {actionsOpen && (
                <div className="absolute left-0 top-full mt-1 w-36 bg-white rounded border border-gray-200 shadow-lg py-1 z-30 text-sm">
                  {actions.map((a, i) => (
                    <button
                      key={i}
                      onClick={() => { a.onClick(); setActionsOpen(false) }}
                      className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右侧：搜索 + 筛选工具 + 分页 */}
        <div className="flex items-center gap-1 flex-1 justify-end min-w-0">

          {/* 搜索框（含 active filter chip） */}
          <div className="flex items-center border border-gray-300 rounded h-8 bg-white overflow-hidden flex-1 max-w-xl min-w-[160px]">
            {activeFilters.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 ml-1.5 px-2 py-0.5 rounded text-xs border shrink-0"
                style={{ background: '#f3eff5', borderColor: '#d4b8d0', color: '#6d4a66' }}
              >
                {f.label}
                <button onClick={f.onRemove} className="hover:opacity-70 ml-0.5 leading-none">×</button>
              </span>
            ))}
            <input
              type="text"
              value={searchValue}
              onChange={e => onSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onSearchSubmit?.()}
              placeholder="Search..."
              className="flex-1 px-2 py-1 text-sm outline-none bg-transparent min-w-0"
            />
            <button
              onClick={onSearchSubmit}
              className="px-2 h-full bg-gray-50 border-l border-gray-200 hover:bg-gray-100 transition-colors shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="6" cy="6" r="4" stroke="#888" strokeWidth="1.5"/>
                <path d="M9 9l3 3" stroke="#888" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* Filters 下拉 */}
          {filterOptions.length > 0 && (
            <div className="relative shrink-0" ref={filterRef}>
              <button
                onClick={() => { setFilterOpen(v => !v); setGroupByOpen(false); setFavOpen(false) }}
                className="h-8 px-2.5 text-xs rounded border bg-white flex items-center gap-1 transition-colors whitespace-nowrap"
                style={{
                  borderColor: filterOpen ? '#875A7B' : '#d1d5db',
                  color: filterOpen ? '#875A7B' : '#4b5563',
                }}
              >
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="shrink-0">
                  <path d="M0 1h10M2 4h6M4 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Filters <Chevron />
              </button>
              {filterOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white rounded border border-gray-200 shadow-lg z-30 text-sm min-w-[160px]">
                  <p className="px-3 pt-2 pb-1 text-xs text-gray-400 font-medium uppercase tracking-wide">按条件筛选</p>
                  {filterOptions.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => { onFilterSelect?.(opt.value); setFilterOpen(false) }}
                      className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Group By 下拉 */}
          {hasGroupBy && (
            <div className="relative shrink-0" ref={groupByRef}>
              <button
                onClick={() => { setGroupByOpen(v => !v); setFilterOpen(false); setFavOpen(false) }}
                className="h-8 px-2.5 text-xs rounded border flex items-center gap-1 transition-colors whitespace-nowrap"
                style={{
                  background: groupByValue && groupByValue !== 'none' ? '#f5f0f7' : 'white',
                  borderColor: groupByValue && groupByValue !== 'none' ? '#875A7B' : '#d1d5db',
                  color: groupByValue && groupByValue !== 'none' ? '#875A7B' : '#4b5563',
                }}
              >
                <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="shrink-0">
                  <path d="M0 1h12M0 5h8M0 9h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Group By <Chevron />
              </button>
              {groupByOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white rounded border border-gray-200 shadow-lg z-30 text-sm min-w-[160px]">
                  <p className="px-3 pt-2 pb-1 text-xs text-gray-400 font-medium uppercase tracking-wide">分组方式</p>
                  {groupByOptions.map(opt => {
                    const active = groupByValue === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          onGroupByChange?.(opt.value)
                          onGroupBySelect?.(opt.value)
                          setGroupByOpen(false)
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center justify-between"
                        style={{ color: active ? '#875A7B' : '#374151', fontWeight: active ? 600 : 400 }}
                      >
                        <span>{opt.label}</span>
                        {active && <span className="text-xs" style={{ color: '#875A7B' }}>✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Favourites 下拉 */}
          {hasFavourites && (
            <div className="relative shrink-0" ref={favRef}>
              <button
                onClick={() => { setFavOpen(v => !v); setFilterOpen(false); setGroupByOpen(false) }}
                className="h-8 px-2.5 text-xs rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 flex items-center gap-1 transition-colors whitespace-nowrap"
              >
                ★ Favourites <Chevron />
              </button>
              {favOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white rounded border border-gray-200 shadow-lg z-30 w-56 overflow-hidden">
                  {savedFavourites.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">暂无保存的筛选</p>
                  )}
                  {savedFavourites.map(f => (
                    <div key={f.name} className="flex items-center hover:bg-gray-50">
                      <button
                        onClick={() => { onFavouriteApply?.(f.state); setFavOpen(false) }}
                        className="flex-1 px-3 py-2 text-left text-sm text-gray-700"
                      >
                        {f.name}
                      </button>
                      <button
                        onClick={() => deleteFavourite(f.name)}
                        className="px-2 py-2 text-xs text-gray-400 hover:text-red-500"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="border-t border-gray-100">
                    {!showFavInput ? (
                      <button
                        onClick={() => setShowFavInput(true)}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-[#875A7B]/20"
                        style={{ color: '#875A7B' }}
                      >
                        + 收藏当前筛选
                      </button>
                    ) : (
                      <div className="px-3 py-2 flex gap-1">
                        <input
                          value={favName}
                          onChange={e => setFavName(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && saveFavourite()}
                          placeholder="筛选名称…"
                          className="flex-1 border rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-purple-400"
                          autoFocus
                        />
                        <button
                          onClick={saveFavourite}
                          className="px-2 py-0.5 text-white text-xs rounded"
                          style={{ background: '#875A7B' }}
                        >
                          保存
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 记录数 + 翻页箭头（仅在提供 onPageChange 时显示翻页控件） */}
          {total > 0 && onPageChange && (
            <div className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
              <span className="whitespace-nowrap">{from}–{to} / {total}</span>
              <button
                onClick={() => page > 1 && onPageChange(page - 1)}
                disabled={page <= 1}
                className="w-6 h-6 flex items-center justify-center border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                ‹
              </button>
              <button
                onClick={() => page < totalPages && onPageChange(page + 1)}
                disabled={page >= totalPages}
                className="w-6 h-6 flex items-center justify-center border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
