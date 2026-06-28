'use client'
import { type ReactNode, type CSSProperties, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import ProductSearchInput from './ProductSearchInput'

export const AMBER_INPUT = 'w-20 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

export interface RowRenderOpts {
  editing: boolean
  inputCls: string
  dragHandle: ReactNode
  deleteButton: ReactNode
  focusSearch: () => void
}

interface Props<
  L extends { id: string; productId?: string | null },
  P extends { id: string; name: string }
> {
  lines: L[]
  editing?: boolean
  tableClassName?: string
  tableStyle?: CSSProperties
  tbodyClassName?: string
  defaultRowCls?: string
  onReorder?: (from: number, to: number) => void
  products?: P[]
  onAddProduct?: (p: P) => void
  searchColSpan?: number
  addProductLabel?: string
  onDeleteLine?: (lineId: string, index: number) => void
  renderHeaders: () => ReactNode
  renderRow: (line: L, index: number, opts: RowRenderOpts) => ReactNode
  rowStyle?: (line: L, index: number) => CSSProperties | undefined
  footer?: ReactNode
  emptyColSpan?: number
  emptyMessage?: string
}

export default function OrderLineEditor<
  L extends { id: string; productId?: string | null },
  P extends { id: string; name: string }
>({
  lines,
  editing = false,
  tableClassName = 'w-full text-sm',
  tableStyle,
  tbodyClassName,
  defaultRowCls = 'border-b border-gray-100 hover:bg-gray-50',
  onReorder,
  products,
  onAddProduct,
  searchColSpan = 18,
  addProductLabel,
  onDeleteLine,
  renderHeaders,
  renderRow,
  rowStyle,
  footer,
  emptyColSpan = 1,
  emptyMessage = '暂无明细',
}: Props<L, P>) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [handleActive, setHandleActive] = useState(false)
  const [query, setQuery] = useState('')

  const psInputRef = useRef<HTMLInputElement>(null)

  function focusSearch() {
    psInputRef.current?.focus()
  }

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

              const deleteButton: ReactNode =
                editing && line.productId && onDeleteLine ? (
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

            {editing && onAddProduct && (
              <tr>
                <td className="px-2 py-2" />
                <td className="px-2 py-2" colSpan={searchColSpan}>
                  <ProductSearchInput
                    value={query}
                    onChange={setQuery}
                    onSelect={p => { onAddProduct(p); setQuery('') }}
                    products={products ?? []}
                    placeholder="Add a product"
                    inputClassName="border border-dashed border-gray-300 rounded px-3 py-1.5 text-sm text-gray-500 focus:outline-none focus:border-purple-400 bg-transparent w-72"
                    portalDropdown={true}
                    externalRef={psInputRef}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && addProductLabel && onAddProduct && (
        <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3">
          <button
            type="button"
            onClick={focusSearch}
            className="text-sm text-[#875A7B] hover:underline font-medium"
          >
            {addProductLabel}
          </button>
        </div>
      )}

      {footer}
    </>
  )
}
