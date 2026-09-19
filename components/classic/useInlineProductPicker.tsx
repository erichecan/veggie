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
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
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
  /**
   * 搜索框刚激活（用户点开选品）时触发。调用方用来强制刷新 `products`——
   * 客户 20260826 报过：编辑完商品/可售单位马上回来下单，页面打开时拉的那份
   * 缓存还没过 30 秒节流窗口，选品选到了旧数据。这里只发信号，不管怎么刷新。
   */
  onActivate?: (lineId: string) => void
  /**
   * 选品被取消时触发：Esc、点到别处、空搜索框上按 Tab，或者直接跑去点另一行的商品格。
   * 选中商品**不**走这里（那条路径不经过 close）。
   *
   * 三个订单页用它把「点开选品又没选商品」的行直接丢掉 —— 那一行本来就是为了选品
   * 才插进来的，没选就没有存在意义，留着只会变成客户 20260918 截图里那种空白行。
   * 是否真的删由调用方决定（已经有商品的行重选时同样会走这里，不能删）。
   */
  onCancel?: (lineId: string) => void
  /** 下拉无匹配时的文案 */
  emptyText?: string
  /** 未选商品时单元格的占位文案 */
  placeholderText?: string
  /** 搜索框的 placeholder */
  searchPlaceholder?: string
  /**
   * 挂在下拉最外层的 class。下单页传 `order-lines-zoom` 把候选列表的字号
   * 跟着订单行一起放大 —— 下拉是 portal 到 body 的，不在那个卡片里，
   * 光给卡片加类管不到它（客户 20260919 截图专门圈了这块）。
   */
  dropdownClassName?: string
  /**
   * 下拉最小宽度(px)。默认跟随商品格宽度；字号放大后商品名容易被 truncate，
   * 调用方可以放宽。
   */
  dropdownMinWidth?: number
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
  onActivate,
  onCancel,
  emptyText,
  placeholderText,
  searchPlaceholder,
  dropdownClassName,
  dropdownMinWidth,
}: UseInlineProductPickerOptions<P>): InlineProductPicker {
  // 调用方（三个页面）不传这几个文案时，兜底也要跟着 locale 走——之前的硬编码中文默认值
  // 在 place-order 页（没传 pickerTexts）会在英文界面下漏出中文（20260904 全库排查发现）。
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const resolvedEmptyText = emptyText ?? (isEn ? 'No matching products' : '没有匹配商品')
  const resolvedPlaceholderText = placeholderText ?? (isEn ? 'Click to select product…' : '点击选择商品…')
  const resolvedSearchPlaceholder = searchPlaceholder ?? (isEn ? 'Search product…' : '搜索商品…')
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  /**
   * 这次选品里用户有没有用方向键显式挑过高亮项。
   *
   * 搜索框还空着时，下拉列的是「全部商品的前 30 条」——它跟用户想找什么毫无关系。
   * 此时 Enter/Tab 若照常"选中高亮的第一条"，一次误触就会把一个陌生商品录进订单
   * （客户 20260918 反馈：录单页莫名多出商品行与空行）。所以空搜索词时只认
   * "用户自己按方向键挑过"这一种显式选择。
   */
  const [arrowUsed, setArrowUsed] = useState(false)
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const dropRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 放 ref 里：close/activate 已经被一串 useCallback 依赖着，再多一个会变身份的
  // 依赖只会让那串回调和 mousedown 监听跟着反复重建
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  /**
   * 刚刚**选中商品**结束的那一行。
   *
   * ⛔ 不能靠 activeLineId 判断这一行是"选中"还是"取消"：pick() 之后紧跟着的
   * activate(下一行) / close 拿到的闭包里，activeLineId 还是刚选完的那一行；而调用方
   * 的填充是异步的（要 await 可售单位、最近成交价），那一刻它的 productId 仍是空。
   * 不记住它，取消回调就会把正在填充的行当成"点开没选的空行"删掉
   * （实测：回车选品后商品行直接消失）。
   */
  const pickedLineRef = useRef<string | null>(null)

  const items = useMemo(
    () => rankByRelevance(products, search, p => [p.name, p.internalRef]).slice(0, MAX_ITEMS),
    [products, search],
  )

  const close = useCallback(() => {
    // 取消而非选中 —— 调用方据此丢掉没选商品的空行。
    // ⛔ 必须在事件阶段直接调，不能塞进 setActiveLineId 的 updater：updater 跑在渲染
    // 阶段，在里面触发调用方的 setState 会撞上 React 的
    // "Cannot update a component while rendering a different component"（实测报错）。
    // 代价是 close 要依赖 activeLineId，于是每次激活都会重建它和那个 mousedown 监听——
    // 这点开销换掉一条渲染期副作用，值。
    if (activeLineId && activeLineId !== pickedLineRef.current) onCancelRef.current?.(activeLineId)
    pickedLineRef.current = null
    setActiveLineId(null)
    setSearch('')
    setHighlight(0)
    setArrowUsed(false)
    setDropRect(null)
  }, [activeLineId])

  /** 改搜索词就把高亮拉回第一条 —— 跟 setSearch 绑在一起，不走 effect */
  const updateSearch = useCallback((v: string) => {
    setSearch(v)
    setHighlight(0)
    setArrowUsed(false)
  }, [])

  const activate = useCallback((lineId: string) => {
    // 从一个没选完的行直接跳到另一行的商品格，前一行同样算"取消"（同 close：事件阶段调）
    if (activeLineId && activeLineId !== lineId && activeLineId !== pickedLineRef.current) {
      onCancelRef.current?.(activeLineId)
    }
    pickedLineRef.current = null
    setActiveLineId(lineId)
    updateSearch('')
    onActivate?.(lineId)
  }, [activeLineId, updateSearch, onActivate])

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

  // 下拉是 fixed 定位、量一次就不再自己动——下拉开着的时候如果页面或表格的
  // overflow-x-auto 容器滚动，输入框会跟着移动，下拉却停在原地，两者就错位了
  // （客户 20260828 反馈）。这里在 scroll/resize 时重新量一次位置；scroll 监听要带
  // capture:true，才能抓到内层可滚动容器（不带 capture 的话 scroll 事件不冒泡，
  // 挂在 window 上的监听器收不到表格内部滚动）。
  useEffect(() => {
    if (!activeLineId) return
    function reposition() {
      const r = inputRef.current?.getBoundingClientRect()
      if (r) setDropRect({ top: r.bottom + 2, left: r.left, width: Math.max(288, r.width) })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [activeLineId])

  const pick = useCallback((lineId: string, p: P) => {
    pickedLineRef.current = lineId
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

    // 高亮这一条算不算"用户真的选了它"：搜过词，或者用方向键挑过。
    // 两者都没有时下拉只是「全部商品前 30 条」的默认展示，不能被一次回车/Tab 录进订单。
    const pickable = hit && (search.trim() !== '' || arrowUsed)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setArrowUsed(true)
      setHighlight(i => Math.min(i + 1, items.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setArrowUsed(true)
      setHighlight(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!pickable) return
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
      if (pickable) {
        const lineId = activeLineId
        pick(lineId, hit)
        if (onSelectByTab) onSelectByTab(lineId)
        else focusDescription(lineId)
      } else if (search.trim() === '') {
        // 空的商品格上按 Tab —— 关掉它，别把一个没选商品的空行焊在激活态
        close()
      }
    }
  }, [activeLineId, items, highlight, arrowUsed, pick, onSelectByEnter, onSelectByTab, focusDescription, search, close])

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
            placeholder={resolvedSearchPlaceholder}
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
        title={productName || resolvedPlaceholderText}
      >
        {productName || resolvedPlaceholderText}
      </div>
    )
  }, [activeLineId, search, updateSearch, handleKey, resolvedSearchPlaceholder, resolvedPlaceholderText, activate])

  const dropdown: ReactNode =
    activeLineId && dropRect && typeof document !== 'undefined'
      ? createPortal(
          <div
            className={dropdownClassName}
            style={{ position: 'fixed', top: dropRect.top, left: dropRect.left, width: dropRect.width, minWidth: dropdownMinWidth, zIndex: 9999 }}
            onMouseDown={e => e.preventDefault()}  // 别让 mousedown 抢走输入框的焦点
          >
            <div ref={listRef} className="bg-white border border-gray-200 rounded shadow-xl max-h-52 overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400 text-center">{resolvedEmptyText}</div>
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
