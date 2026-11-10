'use client'
import { useEffect, useState } from 'react'
import { Menu, PanelLeftClose } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet'
import type { PortalCategory } from './use-customer-portal'

const PURPLE = '#875A7B'

export function CategorySidebar({ categories, activeCategoryId, onSelect, isEn }: {
  categories: PortalCategory[]
  activeCategoryId: string | null
  onSelect: (id: string | null) => void
  isEn: boolean
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [desktopOpen, setDesktopOpen] = useState(true)
  const title = isEn ? 'Categories' : '商品分类'
  const allLabel = isEn ? 'All products' : '全部商品'
  const active = categories.find(c => c.id === activeCategoryId)
  const activeLabel = active ? (isEn ? active.name || active.nameZh : active.nameZh || active.name) : allLabel

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
  const items = (
    <nav aria-label={title} className="space-y-1">
      {[{id: null, label: allLabel, count: null}, ...categories.map(c => ({id:c.id,label:isEn ? c.name || c.nameZh : c.nameZh || c.name,count:c.count}))].map(c => (
        <button key={c.id ?? 'all'} type="button" aria-current={activeCategoryId === c.id ? 'true' : undefined}
          onClick={() => select(c.id)}
          className="w-full min-h-11 px-3 py-2.5 rounded-lg text-sm text-left flex items-start justify-between gap-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#875A7B]"
          style={activeCategoryId === c.id ? {background:PURPLE,color:'white',fontWeight:600} : {color:'#444'}}>
          <span className="min-w-0 break-words">{c.label}</span>
          {c.count !== null && <span className="text-xs shrink-0 pt-0.5 opacity-70">{c.count}</span>}
        </button>
      ))}
    </nav>
  )

  return <>
    <div className="lg:hidden mb-3">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger className="inline-flex max-w-full min-h-11 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
          aria-label={isEn ? 'Open product categories' : '打开商品分类'}>
          <Menu className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{title} · <span style={{color:PURPLE}}>{activeLabel}</span></span>
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
        <h2 className="font-semibold text-sm" style={{color:PURPLE}}>{title}</h2>
        <button type="button" className="min-h-11 min-w-11 inline-flex items-center justify-center rounded hover:bg-gray-100" onClick={() => setDesktopOpen(false)} aria-label={isEn ? 'Collapse product categories' : '收起商品分类'}><PanelLeftClose className="size-5" aria-hidden="true" /></button>
      </div>
      {items}
    </aside> : <button type="button" onClick={() => setDesktopOpen(true)} aria-label={isEn ? 'Expand product categories' : '展开商品分类'} className="hidden lg:inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border bg-white" title={title}><Menu className="size-5" aria-hidden="true" /></button>}
  </>
}
