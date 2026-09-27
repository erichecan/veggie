'use client'
import type { PortalCategory } from './use-customer-portal'

const PURPLE = '#875A7B'

export function CategorySidebar({
  categories, activeCategoryId, onSelect, isEn,
}: {
  categories: PortalCategory[]
  activeCategoryId: string | null
  onSelect: (id: string | null) => void
  isEn: boolean
}) {
  if (categories.length === 0) return null

  return (
    <nav className="flex-none w-36 sm:w-44 space-y-0.5">
      <button
        onClick={() => onSelect(null)}
        className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors"
        style={activeCategoryId === null ? { background: PURPLE, color: 'white' } : { color: '#444' }}
      >
        {isEn ? 'All' : '全部'}
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between gap-1"
          style={activeCategoryId === c.id ? { background: PURPLE, color: 'white', fontWeight: 500 } : { color: '#444' }}
        >
          <span className="truncate">{isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)}</span>
          <span className="text-xs flex-none" style={{ opacity: 0.7 }}>{c.count}</span>
        </button>
      ))}
    </nav>
  )
}
