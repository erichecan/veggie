'use client'
import { type ReactNode, type CSSProperties, useRef, useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'

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
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)

  const filteredProducts = useMemo(
    () => (products ?? []).filter(p => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 20),
    [products, query],
  )

  function updateRect() {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect()
      setRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width })
    }
  }

  function focusSearch() {
    setOpen(true)
    updateRect()
    inputRef.current?.focus()
  }

  function selectProduct(p: P) {
    onAddProduct?.(p)
    setQuery('')
    setOpen(false)
    setHighlight(-1)
  }

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (
        !containerRef.current?.contains(e.target as Node) &&
        !portalRef.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

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
                  <div ref={containerRef}>
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      placeholder="Add a product"
                      onChange={e => {
                        setQuery(e.target.value)
                        setHighlight(-1)
                        setOpen(true)
                        updateRect()
                      }}
                      onFocus={() => {
                        setOpen(true)
                        updateRect()
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          setOpen(false)
                          setHighlight(-1)
                          return
                        }
                        if (e.key === 'Tab') {
                          setOpen(false)
                          return
                        }
                        if (!open || filteredProducts.length === 0) return
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setHighlight(h => Math.min(h + 1, filteredProducts.length - 1))
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setHighlight(h => Math.max(h - 1, 0))
                        } else if (e.key === 'Enter') {
                          e.preventDefault()
                          const idx = highlight >= 0 ? highlight : 0
                          if (filteredProducts[idx]) selectProduct(filteredProducts[idx])
                        }
                      }}
                      className="border border-dashed border-gray-300 rounded px-3 py-1.5 text-sm text-gray-500 focus:outline-none focus:border-purple-400 bg-transparent w-72"
                    />
                  </div>
                  {open &&
                    filteredProducts.length > 0 &&
                    rect &&
                    typeof document !== 'undefined' &&
                    createPortal(
                      <div
                        ref={portalRef}
                        style={{
                          position: 'absolute',
                          top: rect.top + 2,
                          left: rect.left,
                          width: Math.max(rect.width, 288),
                          zIndex: 9999,
                        }}
                        className="bg-white border border-gray-200 rounded shadow-lg max-h-52 overflow-y-auto"
                      >
                        {filteredProducts.map((p, idx) => (
                          <button
                            key={p.id}
                            type="button"
                            onMouseDown={() => {
                              selectProduct(p)
                              setHighlight(-1)
                            }}
                            onMouseEnter={() => setHighlight(idx)}
                            className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === highlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )}
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
