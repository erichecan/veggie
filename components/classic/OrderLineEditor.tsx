'use client'
import { type ReactNode, type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  useInlineProductPicker,
  type InlineProductPickerProduct,
  type ProductCellOptions,
} from './useInlineProductPicker'

export const AMBER_INPUT = 'w-20 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

export interface RowRenderOpts {
  editing: boolean
  inputCls: string
  dragHandle: ReactNode
  deleteButton: ReactNode
  focusSearch: () => void
  /** 附加到「选完产品后应该获得焦点」的字段（通常是数量框），用于 Tab 键从搜索框跳入新行 */
  firstFieldRef: (el: HTMLElement | null) => void
  /**
   * 商品单元格的内容——就地搜索、下拉、键盘走位全在里面。
   * 新建页与编辑页调用的是同一个实现，Tab / Enter 的行为因此不可能再分叉。
   * 只在传了 `onPickProduct` 时可用；没传时返回 null，调用方自己渲染。
   */
  productCell: (opts: ProductCellOptions) => ReactNode
}

interface Props<
  L extends { id: string; productId?: string | null },
  P extends InlineProductPickerProduct
> {
  lines: L[]
  editing?: boolean
  tableClassName?: string
  tableStyle?: CSSProperties
  tbodyClassName?: string
  defaultRowCls?: string
  onReorder?: (from: number, to: number) => void
  products?: P[]
  onDeleteLine?: (lineId: string, index: number) => void
  /**
   * 行内选商品：传了才启用 `RowRenderOpts.productCell`。
   * 回调里做业务（定价、税率、单位），交互不归调用方管。
   */
  onPickProduct?: (lineId: string, product: P) => void
  /** Enter 选中商品后的动作，新建页在这里再开一个空行实现连续录入 */
  onPickByEnter?: (lineId: string) => void
  /** Tab 选中商品后的动作，默认聚焦该行的 `[data-desc-line]` 描述框 */
  onPickByTab?: (lineId: string) => void
  /** 搜索框刚激活时的动作——调用方在这里强制刷新 `products`，别信 30 秒节流那份缓存 */
  onPickerActivate?: (lineId: string) => void
  /** 点底部「+ Add a product」——通常是往 lines 末尾插一个空行并激活它 */
  onAddBlankLine?: () => void
  /** 底部「+ Add a product」的文案，跟随页面语言 */
  addBlankLineText?: string
  pickerTexts?: { empty?: string; placeholder?: string; search?: string }
  renderHeaders: () => ReactNode
  renderRow: (line: L, index: number, opts: RowRenderOpts) => ReactNode
  rowStyle?: (line: L, index: number) => CSSProperties | undefined
  footer?: ReactNode
  emptyColSpan?: number
  emptyMessage?: string
  /**
   * 把内部能力暴露给外层，挂载后调用一次。
   * focusSearch —— 页面级快捷键（如 Alt+N）用的「去下一行」：插空行并进入选品。
   * activateProductPicker —— 页面自己插完行后，让那一行立刻进入搜索态。
   */
  onReady?: (api: { focusSearch: () => void; activateProductPicker: (lineId: string) => void }) => void
}

export default function OrderLineEditor<
  L extends { id: string; productId?: string | null },
  P extends InlineProductPickerProduct
>({
  lines,
  editing = false,
  tableClassName = 'w-full text-sm',
  tableStyle,
  tbodyClassName,
  defaultRowCls = 'border-b border-gray-100 hover:bg-gray-50',
  onReorder,
  products,
  onDeleteLine,
  onPickProduct,
  onPickByEnter,
  onPickByTab,
  onPickerActivate,
  onAddBlankLine,
  addBlankLineText = '+ Add a product',
  pickerTexts,
  renderHeaders,
  renderRow,
  rowStyle,
  footer,
  emptyColSpan = 1,
  emptyMessage = '暂无明细',
  onReady,
}: Props<L, P>) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [handleActive, setHandleActive] = useState(false)

  const firstFieldRefs = useRef<Map<number, HTMLElement>>(new Map())

  /**
   * 「去下一行」。三个页面共用同一个语义：插一个空行并让它进入选品搜索态。
   *
   * 编辑态以前是「聚焦表格底部那个搜索框」，新建态是「开新行」——同一个按键
   * （字段上按 Enter、页面快捷键）在两边做不同的事，正是客户反复报 Tab/Enter
   * 不一致的原因之一。底部搜索框已经拿掉，这里收口成一种。
   */
  const focusSearch = useCallback(() => {
    onAddBlankLine?.()
  }, [onAddBlankLine])

  const noopPick = useCallback(() => {}, [])
  const picker = useInlineProductPicker<P>({
    products: products ?? [],
    onSelect: onPickProduct ?? noopPick,
    onSelectByEnter: onPickByEnter,
    onSelectByTab: onPickByTab,
    onActivate: onPickerActivate,
    emptyText: pickerTexts?.empty,
    placeholderText: pickerTexts?.placeholder,
    searchPlaceholder: pickerTexts?.search,
  })
  const { activate: activateProductPicker, productCell } = picker

  useEffect(() => {
    onReady?.({ focusSearch, activateProductPicker })
  }, [onReady, focusSearch, activateProductPicker])

  const canDrag = editing && !!onReorder

  return (
    <>
      <div className="overflow-x-auto">
        <table className={tableClassName} style={tableStyle}>
          <thead>{renderHeaders()}</thead>
          <tbody className={tbodyClassName}>
            {lines.map((line, i) => {
              const isDragging = dragIndex === i
              const isOver = canDrag && overIndex === i && dragIndex !== null && dragIndex !== i

              const dragHandle: ReactNode = canDrag ? (
                <span
                  title="拖动以调整顺序"
                  onMouseDown={() => setHandleActive(true)}
                  onMouseUp={() => setHandleActive(false)}
                  className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 select-none leading-none"
                >
                  ☰
                </span>
              ) : null

              // 还没选商品的草稿行也要能删 —— 否则点错「+ Add a product」
              // 留下的空行只能靠 Discard 整单丢弃
              const deleteButton: ReactNode =
                editing && onDeleteLine ? (
                  <button
                    onClick={() => onDeleteLine(line.id, i)}
                    className="text-red-400 hover:text-red-600 leading-none"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null

              const opts: RowRenderOpts = {
                editing,
                inputCls: AMBER_INPUT,
                dragHandle,
                deleteButton,
                focusSearch,
                firstFieldRef: el => {
                  if (el) firstFieldRefs.current.set(i, el)
                  else firstFieldRefs.current.delete(i)
                },
                productCell: opts => (onPickProduct ? productCell(opts) : null),
              }

              const cls = [
                defaultRowCls,
                isDragging ? 'opacity-40' : '',
                isOver ? 'border-t-2 border-t-[#875A7B]' : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <tr
                  key={line.id}
                  draggable={canDrag && handleActive}
                  onDragStart={canDrag ? () => setDragIndex(i) : undefined}
                  onDragOver={
                    canDrag
                      ? e => {
                          e.preventDefault()
                          if (overIndex !== i) setOverIndex(i)
                        }
                      : undefined
                  }
                  onDrop={
                    canDrag
                      ? e => {
                          e.preventDefault()
                          if (dragIndex !== null) onReorder!(dragIndex, i)
                          setDragIndex(null)
                          setOverIndex(null)
                          setHandleActive(false)
                        }
                      : undefined
                  }
                  onDragEnd={() => {
                    setDragIndex(null)
                    setOverIndex(null)
                    setHandleActive(false)
                  }}
                  className={cls}
                  style={rowStyle?.(line, i)}
                >
                  {renderRow(line, i, opts)}
                </tr>
              )
            })}

            {lines.length === 0 && (
              <tr>
                <td colSpan={emptyColSpan} className="px-3 py-8 text-center text-gray-400">
                  {emptyMessage}
                </td>
              </tr>
            )}

          </tbody>
        </table>
      </div>

      {onAddBlankLine && (
        <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3 flex-wrap">
          <button
            onClick={onAddBlankLine}
            className="text-sm text-[#875A7B] hover:underline font-medium"
          >
            {addBlankLineText}
          </button>
        </div>
      )}

      {footer}
      {picker.dropdown}
    </>
  )
}
