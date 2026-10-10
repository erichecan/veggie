'use client'
import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { rankByRelevance } from '@/lib/search-rank'

interface Props<P extends { id: string; name: string; internalRef?: string | null; category?: string | null; qtyOnHand?: number | null; purchaseUomSpec?: string | null }> {
  value: string
  onChange: (v: string) => void
  onSelect: (p: P) => void
  products: P[]
  placeholder?: string
  inputClassName?: string
  showForecastQuantity?: boolean
  portalDropdown?: boolean
  maxResults?: number
  showOnEmptyQuery?: boolean
  externalRef?: React.RefObject<HTMLInputElement | null>
  /** Tab 键选中当前高亮/首个匹配项，无匹配则照常跳到下一个控件（默认 false，保持原有 Tab=跳过行为） */
  selectOnTab?: boolean
  /** 通过 Tab 键选中项目时触发（区别于 Enter/点击选中），供外层把焦点移到新增行的下一个字段 */
  onTabSelect?: (p: P) => void
}

export default function ProductSearchInput<
  P extends { id: string; name: string; internalRef?: string | null; category?: string | null; qtyOnHand?: number | null; purchaseUomSpec?: string | null }
>({
  value,
  onChange,
  onSelect,
  products,
  placeholder = 'Search products…',
  inputClassName,
  showForecastQuantity = false,
  portalDropdown = false,
  maxResults = 20,
  showOnEmptyQuery = true,
  externalRef,
  selectOnTab = false,
  onTabSelect,
}: Props<P>) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [rect, setRect] = useState<{
    left: number
    width: number
    maxHeight: number
    /** 'below' 贴在输入框下方；输入框离视口底部太近(典型:弹窗里靠下的行)时翻到上方，
     * 否则下拉菜单会被裁掉一截看不见——这正是采购单导入"下拉被挡住"的根因 */
    placement: 'below' | 'above'
    offset: number
  } | null>(null)

  const localInputRef = useRef<HTMLInputElement>(null)
  const inputRef = (externalRef ?? localInputRef) as React.RefObject<HTMLInputElement | null>
  const containerRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const filtered = useMemo(() => {
    if (!showOnEmptyQuery && !value.trim()) return []
    return rankByRelevance(products, value, p => [p.name, p.internalRef]).slice(0, maxResults)
  }, [products, value, showOnEmptyQuery, maxResults])

  const updateRect = useCallback(() => {
    if (!inputRef.current) return
    const r = inputRef.current.getBoundingClientRect()
    const MARGIN = 8
    const spaceBelow = window.innerHeight - r.bottom - MARGIN
    const spaceAbove = r.top - MARGIN
    // 下方空间不够放一个最小可用列表(120px)且上方更宽裕时才翻上去，
    // 避免输入框刚好在视口正中间时来回跳
    const placement: 'below' | 'above' = spaceBelow < 120 && spaceAbove > spaceBelow ? 'above' : 'below'
    const maxHeight = Math.max(120, Math.min(320, (placement === 'below' ? spaceBelow : spaceAbove)))
    setRect({
      left: r.left,
      width: r.width,
      maxHeight,
      placement,
      offset: placement === 'below' ? r.bottom + 2 : window.innerHeight - r.top + 2,
    })
  }, [inputRef])

  // 下拉开着时持续跟手：输入框所在的弹窗/容器内部滚动(本页就是这种场景——
  // "识别结果核对"弹窗本身 overflow-auto)不会触发 resize，只会触发 scroll，
  // 之前只在打开那一刻算一次位置，弹窗一滚下拉就跟丢了，看起来像"被挡住"
  useEffect(() => {
    if (!open || !portalDropdown) return
    window.addEventListener('scroll', updateRect, true)
    window.addEventListener('resize', updateRect)
    return () => {
      window.removeEventListener('scroll', updateRect, true)
      window.removeEventListener('resize', updateRect)
    }
  }, [open, portalDropdown, updateRect])

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

  useEffect(() => {
    if (highlight >= 0) itemRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const dropdownItems = filtered.map((p, idx) => (
    <button
      key={p.id}
      ref={el => { itemRefs.current[idx] = el }}
      type="button"
      onMouseDown={() => { select(p); setHighlight(-1) }}
      onMouseEnter={() => setHighlight(idx)}
      className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === highlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
    >
      <span className="font-medium">{p.name}</span>
      {p.purchaseUomSpec && <span className="ml-2 text-xs text-gray-500">({p.purchaseUomSpec})</span>}
      {p.internalRef && <span className="ml-2 text-[10px] text-gray-400">[{p.internalRef}]</span>}
      {p.category && <span className="ml-2 text-xs text-gray-400">{p.category}</span>}
      {showForecastQuantity && p.qtyOnHand != null && (
        <span className={`ml-2 text-xs ${Number(p.qtyOnHand) > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          Forecast quantity: {Number(p.qtyOnHand).toFixed(0)}
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
              // 阻止默认跳格与外层容器的 Tab 焦点管理(handleTabNav)。
              // Tab 与 Enter 的选中逻辑相同,但 Tab 之后要把焦点交给 onTabSelect
              // (通常是新增行的数量字段),而不是留在搜索框里
              e.preventDefault()
              e.stopPropagation()
              const p = filtered[highlight >= 0 ? highlight : 0]
              select(p)
              onTabSelect?.(p)
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
        <div className="absolute z-50 mt-1 left-0 right-0 bg-white border border-gray-200 rounded shadow-lg max-h-80 overflow-y-auto">
          {dropdownItems}
        </div>
      )}
      {showDropdown && portalDropdown && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={portalRef}
          style={{
            position: 'fixed',
            [rect.placement === 'below' ? 'top' : 'bottom']: rect.offset,
            left: rect.left,
            width: Math.max(rect.width, 288),
            maxHeight: rect.maxHeight,
            zIndex: 9999,
          }}
          className="bg-white border border-gray-200 rounded shadow-lg overflow-y-auto"
        >
          {dropdownItems}
        </div>,
        document.body,
      )}
    </div>
  )
}
