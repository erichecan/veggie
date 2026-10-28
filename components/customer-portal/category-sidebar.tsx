'use client'
import { useState } from 'react'
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
  // 移动端默认收起抽屉，给商品列表留更多横向空间；点击触发按钮才展开
  const [open, setOpen] = useState(false)

  if (categories.length === 0) return null

  const activeLabel = (() => {
    if (activeCategoryId === null) return isEn ? 'All' : '全部'
    const c = categories.find((x) => x.id === activeCategoryId)
    return c ? (isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)) : (isEn ? 'All' : '全部')
  })()

  const items = (
    <>
      <button
        onClick={() => { onSelect(null); setOpen(false) }}
        className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors"
        style={activeCategoryId === null ? { background: PURPLE, color: 'white' } : { color: '#444' }}
      >
        {isEn ? 'All' : '全部'}
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          onClick={() => { onSelect(c.id); setOpen(false) }}
          className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between gap-1"
          style={activeCategoryId === c.id ? { background: PURPLE, color: 'white', fontWeight: 500 } : { color: '#444' }}
        >
          <span className="truncate">{isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)}</span>
          <span className="text-xs flex-none" style={{ opacity: 0.7 }}>{c.count}</span>
        </button>
      ))}
    </>
  )

  return (
    <>
      {/* lg 以下：折叠成一条触发按钮，点击再展开抽屉 */}
      <button
        onClick={() => setOpen(true)}
        className="lg:hidden w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm mb-3"
        style={{ borderColor: '#ddd', color: '#444' }}
      >
        <span className="truncate">{isEn ? 'Category: ' : '分类：'}<span className="font-medium" style={{ color: PURPLE }}>{activeLabel}</span></span>
        <span className="flex-none text-xs text-gray-400">▾</span>
      </button>

      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative bg-white w-64 max-w-[80vw] h-full overflow-y-auto p-3 shadow-xl space-y-0.5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-sm" style={{ color: PURPLE }}>{isEn ? 'Categories' : '商品分类'}</span>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none px-1">✕</button>
            </div>
            {items}
          </div>
        </div>
      )}

      {/* lg 及以上：常驻侧栏，行为跟改造前一致 */}
      <nav className="hidden lg:block flex-none w-44 space-y-0.5">
        {items}
      </nav>
    </>
  )
}
