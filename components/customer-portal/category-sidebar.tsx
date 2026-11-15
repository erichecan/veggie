'use client'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Menu, PanelLeftClose } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet'
import type { PortalCategory } from './use-customer-portal'

const PRIMARY = '#356b2f'

type CategoryNode = PortalCategory & { children: CategoryNode[]; totalCount: number }

function makeCategoryTree(categories: PortalCategory[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>()
  for (const category of categories) byId.set(category.id, { ...category, children: [], totalCount: category.count })

  const roots: CategoryNode[] = []
  for (const category of categories) {
    const node = byId.get(category.id)!
    const parent = category.parentId ? byId.get(category.parentId) : undefined
    if (parent && parent.id !== node.id) parent.children.push(node)
    else roots.push(node)
  }

  function sumAndSort(nodes: CategoryNode[], visited = new Set<string>()) {
    for (const node of nodes) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      sumAndSort(node.children, visited)
      node.children.sort((a, b) => b.totalCount - a.totalCount)
      node.totalCount = node.count + node.children.reduce((sum, child) => sum + child.totalCount, 0)
    }
  }
  sumAndSort(roots)
  roots.sort((a, b) => b.totalCount - a.totalCount)
  return roots
}

export function CategorySidebar({ categories, activeCategoryId, onSelect, isEn }: {
  categories: PortalCategory[]
  activeCategoryId: string | null
  onSelect: (id: string | null) => void
  isEn: boolean
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [desktopOpen, setDesktopOpen] = useState(true)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const title = isEn ? 'Categories' : '商品分类'
  const allLabel = isEn ? 'All products' : '全部商品'
  const categoryById = new Map(categories.map(category => [category.id, category]))
  const tree = makeCategoryTree(categories)
  const active = categories.find(c => c.id === activeCategoryId)
  const activeLabel = active ? (isEn ? active.name || active.nameZh : active.nameZh || active.name) : allLabel

  useEffect(() => {
    if (!activeCategoryId) return
    const ancestors = new Set<string>()
    let current = categoryById.get(activeCategoryId)
    while (current?.parentId) {
      ancestors.add(current.parentId)
      current = categoryById.get(current.parentId)
    }
    if (ancestors.size) setExpandedIds(previous => new Set([...previous, ...ancestors]))
  // categoryById is derived from categories; category updates should reveal the active path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategoryId, categories])

  // A modal opened on a phone must release its scroll/focus lock when resized to desktop.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  if (!categories.length) return null

  function select(id: string | null) {
    onSelect(id)
    setMobileOpen(false)
  }

  function toggleCategory(id: string) {
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderTree(nodes: CategoryNode[], depth = 0): React.ReactNode {
    return nodes.map(category => {
      const label = isEn ? category.name || category.nameZh : category.nameZh || category.name
      const hasChildren = category.children.length > 0
      const expanded = expandedIds.has(category.id)
      const selected = activeCategoryId === category.id
      return <li key={category.id}>
        <div className="flex min-w-0 items-stretch gap-0.5" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? <button type="button" aria-label={`${expanded ? (isEn ? 'Collapse' : '收起') : (isEn ? 'Expand' : '展开')} ${label}`} aria-expanded={expanded}
            onClick={() => toggleCategory(category.id)}
            className="inline-flex min-h-11 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-green-700">
            {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          </button> : <span aria-hidden="true" className="w-8 shrink-0" />}
          <button type="button" aria-current={selected ? 'true' : undefined} onClick={() => select(category.id)}
            className="flex min-h-11 min-w-0 flex-1 items-start justify-between gap-2 rounded-lg px-2 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
            style={selected ? { background: PRIMARY, color: 'white', fontWeight: 600 } : { color: '#444' }}>
            <span className="min-w-0 break-words">{label}</span>
            <span className="shrink-0 pt-0.5 text-xs opacity-70">{category.totalCount}</span>
          </button>
        </div>
        {hasChildren && expanded && <ul className="mt-1 space-y-1">{renderTree(category.children, depth + 1)}</ul>}
      </li>
    })
  }

  const items = (
    <nav aria-label={title} className="space-y-1">
      <button type="button" aria-current={activeCategoryId === null ? 'true' : undefined}
        onClick={() => select(null)}
        className="w-full min-h-11 px-3 py-2.5 rounded-lg text-sm text-left flex items-start justify-between gap-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
        style={activeCategoryId === null ? {background:PRIMARY,color:'white',fontWeight:600} : {color:'#444'}}>
        <span className="min-w-0 break-words">{allLabel}</span>
      </button>
      <ul className="space-y-1">
        {renderTree(tree)}
      </ul>
    </nav>
  )

  return <>
    <div className="lg:hidden mb-3">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger className="inline-flex max-w-full min-h-11 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
          aria-label={isEn ? 'Open product categories' : '打开商品分类'}>
          <Menu className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{title} · <span style={{color:PRIMARY}}>{activeLabel}</span></span>
        </SheetTrigger>
        <SheetContent side="left" className="data-[side=left]:w-[min(20rem,85vw)] gap-0">
          <SheetHeader className="pr-14 pt-[max(1rem,env(safe-area-inset-top))]">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{isEn ? 'Choose a category to filter products.' : '选择分类，查看对应商品。'}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{items}</div>
        </SheetContent>
      </Sheet>
    </div>
    {desktopOpen ? <aside className="hidden lg:block sticky top-20 max-h-[calc(100dvh-6rem)] w-52 shrink-0 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-2">
        <h2 className="font-semibold text-sm" style={{color:PRIMARY}}>{title}</h2>
        <button type="button" className="min-h-11 min-w-11 inline-flex items-center justify-center rounded hover:bg-gray-100" onClick={() => setDesktopOpen(false)} aria-label={isEn ? 'Collapse product categories' : '收起商品分类'}><PanelLeftClose className="size-5" aria-hidden="true" /></button>
      </div>
      {items}
    </aside> : <button type="button" onClick={() => setDesktopOpen(true)} aria-label={isEn ? 'Expand product categories' : '展开商品分类'} className="hidden lg:inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border bg-white" title={title}><Menu className="size-5" aria-hidden="true" /></button>}
  </>
}
