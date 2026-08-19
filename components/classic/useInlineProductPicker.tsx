'use client'
/**
 * 订单行「就地选商品」的唯一实现
 * ============================================================================
 * 点商品单元格 → 原地长出搜索框 → 下拉选中 → 焦点交给下一个字段。
 *
 * 这套交互原本只长在新建订单页（`place-order`）的页面级 state 里，
 * 编辑态（报价单 / 销售单详情）则是另一套「表格底部一个搜索框，选完追加行」。
 * 两套实现导致 Tab / Enter 行为对不上——客户 20260814 报过一次，
 * 当时只统一了「字段上的键盘处理」（`lib/order-line-keys.ts`）而没统一加商品本身，
 * 所以 20260818 又被报了一次。这次把交互整体收口到这里，三个页面共用。
 *
 * ⛔ 这里只管**交互**，不碰业务：选中商品之后该用哪条定价链、要不要查最近成交价、
 * 新行怎么进 state，全部由调用方在 `onSelect` 里决定。新建与编辑的业务本来就不同，
 * 混进来就等于把两套业务又焊死在一起。
 *
 * ## 两个不能改的实现细节
 *
 * 1. **下拉必须走 portal 挂在 body 上**。表格外面套着 `overflow-x-auto`，
 *    下拉直接渲染在单元格里会被裁掉。所以位置靠 `getBoundingClientRect()`
 *    量出来后用 fixed 定位。
 * 2. **量位置要等输入框真的渲染出来**。激活的那一帧输入框还没进 DOM，
 *    立刻量会拿到 null，所以隔一个 20ms 的 timeout 再量。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { rankByRelevance } from '@/lib/search-rank'

/** 下拉最多展示多少条 —— 与改造前 place-order 的行为保持一致 */
const MAX_ITEMS = 30

export interface InlineProductPickerProduct {
  id: string
  name: string
  internalRef?: string | null
}

export interface UseInlineProductPickerOptions<P extends InlineProductPickerProduct> {
  products: P[]
  /**
   * 选中商品。调用方负责把它写进对应的行（定价、税率、单位等都在这里做）。
   * 新建页走 `computeLinePrice`，编辑页走 `resolveCustomerPrice` + 最近成交价——
   * 两者本就不同，所以这里只给回调，不给实现。
   */
  onSelect: (lineId: string, product: P) => void
  /**
   * Enter 选中后的动作：新建页在这里再开一个空行，实现「连续录入」。
   * 不传则选完就停在当前行。
   */
  onSelectByEnter?: (lineId: string) => void
  /**
   * Tab 选中后的动作：默认把焦点交给该行的描述框（`[data-desc-line]`）。
   * 传了就用调用方的实现。
   */
  onSelectByTab?: (lineId: string) => void
  /** 下拉无匹配时的文案 */
  emptyText?: string
  /** 未选商品时单元格的占位文案 */
  placeholderText?: string
  /** 搜索框的 placeholder */
  searchPlaceholder?: string
}

export interface ProductCellOptions {
  lineId: string
  /** 已选中的商品名；空表示这行还没选商品 */
  productName?: string | null
  /**
   * 只读：渲染成纯文本，点了也不会进搜索态。
   * 编辑页的**已存在行**用它——换 productId 会牵动价格快照、提成快照、
   * 拣货锁与库存流水，不是一个单元格点一下该承担的后果。
   */
  readOnly?: boolean
}

export interface InlineProductPicker {
  activeLineId: string | null
  /** 让某一行进入搜索态（新增空行后自动聚焦就靠它） */
  activate: (lineId: string) => void
  close: () => void
  /** 渲染商品单元格的内容，三个页面调用同一个 */
  productCell: (opts: ProductCellOptions) => ReactNode
  /** 下拉本体，挂在 body 上；调用方需要把它渲染出来（放在组件树任意位置即可） */
  dropdown: ReactNode
}

export function useInlineProductPicker<P extends InlineProductPickerProduct>({
  products,
  onSelect,
  onSelectByEnter,
  onSelectByTab,
  emptyText = '没有匹配商品',
  placeholderText = '点击选择商品…',
  searchPlaceholder = '搜索商品…',
}: UseInlineProductPickerOptions<P>): InlineProductPicker {
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const dropRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo(
    () => rankByRelevance(products, search, p => [p.name, p.internalRef]).slice(0, MAX_ITEMS),
    [products, search],
  )

  const close = useCallback(() => {
    setActiveLineId(null)
    setSearch('')
    setHighlight(0)
    setDropRect(null)
  }, [])

  /** 改搜索词就把高亮拉回第一条 —— 跟 setSearch 绑在一起，不走 effect */
  const updateSearch = useCallback((v: string) => {
    setSearch(v)
    setHighlight(0)
  }, [])

  const activate = useCallback((lineId: string) => {
    setActiveLineId(lineId)
    updateSearch('')
  }, [updateSearch])

  // 点到别处就收起。注意判定用的是 dropRef（输入框那一小块），
  // 不是下拉本身——下拉在 portal 里，不是它的后代。下拉自己靠 onMouseDown
  // preventDefault 保住焦点，不会走到这里。
  useEffect(() => {
    function onMouse(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onMouse)
    return () => document.removeEventListener('mousedown', onMouse)
  }, [close])

  useEffect(() => {
    if (!activeLineId) return
    const el = listRef.current?.querySelector(`[data-idx="${highlight}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, activeLineId])

  // 见文件头第 2 点：等输入框进 DOM 再量位置。
  // 不激活时无需清 dropRect —— 下拉的渲染条件本来就带 activeLineId。
  useEffect(() => {
    if (!activeLineId) return
    const t = setTimeout(() => {
      const r = inputRef.current?.getBoundingClientRect()
      if (r) setDropRect({ top: r.bottom + 2, left: r.left, width: Math.max(288, r.width) })
    }, 20)
    return () => clearTimeout(t)
  }, [activeLineId])

  const pick = useCallback((lineId: string, p: P) => {
    onSelect(lineId, p)
    setActiveLineId(null)
    setSearch('')
    setHighlight(0)
    setDropRect(null)
  }, [onSelect])

  const focusDescription = useCallback((lineId: string) => {
    // 50ms：等选中商品引发的重渲染落地，否则查到的还是旧节点
    setTimeout(() => {
      document.querySelector<HTMLInputElement>(`[data-desc-line="${lineId}"]`)?.focus()
    }, 50)
  }, [])

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (!activeLineId) return
    const hit = items[highlight]

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(i => Math.min(i + 1, items.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!hit) return
      const lineId = activeLineId
      pick(lineId, hit)
      // 连续录入：选完立刻开下一个商品行，再按回车就能接着录
      onSelectByEnter?.(lineId)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (hit) {
        const lineId = activeLineId
        pick(lineId, hit)
        if (onSelectByTab) onSelectByTab(lineId)
        else focusDescription(lineId)
      } else if (search.trim() === '') {
        // 空的商品格上按 Tab —— 关掉它，别把一个没选商品的空行焊在激活态
        close()
      }
    }
  }, [activeLineId, items, highlight, pick, onSelectByEnter, onSelectByTab, focusDescription, search, close])

  const productCell = useCallback(({ lineId, productName, readOnly }: ProductCellOptions): ReactNode => {
    if (readOnly) {
      return <span className="text-[#875A7B]">{productName || ''}</span>
    }
    if (activeLineId === lineId) {
      return (
        <div ref={dropRef}>
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={search}
            onChange={e => updateSearch(e.target.value)}
            onKeyDown={handleKey}
            placeholder={searchPlaceholder}
            className="w-full border border-[#875A7B] rounded px-2 py-0.5 text-xs focus:outline-none"
            onClick={e => e.stopPropagation()}
            onFocus={() => {
              const r = inputRef.current?.getBoundingClientRect()
              if (r) setDropRect({ top: r.bottom + 2, left: r.left, width: Math.max(288, r.width) })
            }}
          />
        </div>
      )
    }
    return (
      <div
        onClick={() => activate(lineId)}
        className={`px-2 py-0.5 rounded cursor-pointer hover:bg-[#875A7B]/20 min-h-[22px] truncate ${
          productName ? 'text-[#875A7B] underline-offset-2' : 'text-gray-400 italic'
        }`}
        title={productName || placeholderText}
      >
        {productName || placeholderText}
      </div>
    )
  }, [activeLineId, search, updateSearch, handleKey, searchPlaceholder, placeholderText, activate])

  const dropdown: ReactNode =
    activeLineId && dropRect && typeof document !== 'undefined'
      ? createPortal(
          <div
            style={{ position: 'fixed', top: dropRect.top, left: dropRect.left, width: dropRect.width, zIndex: 9999 }}
            onMouseDown={e => e.preventDefault()}  // 别让 mousedown 抢走输入框的焦点
          >
            <div ref={listRef} className="bg-white border border-gray-200 rounded shadow-xl max-h-52 overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400 text-center">{emptyText}</div>
              ) : (
                items.map((p, idx) => (
                  <div
                    key={p.id}
                    data-idx={idx}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={e => { e.preventDefault(); pick(activeLineId, p) }}
                    className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-[#875A7B]/20 flex items-center gap-2 ${
                      idx === highlight ? 'bg-[#875A7B]/20' : ''
                    }`}
                  >
                    <span className="font-medium text-gray-800 truncate flex-1">{p.name}</span>
                    {p.internalRef && (
                      <span className="text-gray-400 text-[10px] shrink-0">[{p.internalRef}]</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )
      : null

  return { activeLineId, activate, close, productCell, dropdown }
}
