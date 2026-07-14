'use client'
import { useState } from 'react'

interface RowsPerPagePaginationProps {
  total: number
  page: number
  pageSize: number
  onPageChange: (p: number) => void
  /** 传入后，"{from}–{to} / {total}" 变成可点击编辑（点一下弹出数字输入框，回车/失焦提交） */
  onPageSizeChange?: (ps: number) => void
  /** onPageSizeChange 的可编辑上限，默认 200 */
  pageSizeMax?: number
}

/**
 * Odoo 式紧凑分页控件："{from}–{to} / {total} ‹ ›"，可选每页条数点击编辑。
 * 从 OdooControlPanel 抽出来独立复用（quotations/products/customers 等列表页共用）。
 */
export default function RowsPerPagePagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeMax = 200,
}: RowsPerPagePaginationProps) {
  const [editing, setEditing] = useState(false)
  // 每次点击进入编辑态时(见下方 onClick)才从 pageSize prop 重新取值，不用 effect 同步——
  // 编辑期间 prop 不会变(onPageSizeChange 要等 blur/Enter 提交后才触发上层重取)，不需要额外监听。
  const [draft, setDraft] = useState(String(pageSize))

  if (total === 0 || !onPageChange) return null

  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1

  function commit() {
    setEditing(false)
    const n = parseInt(draft, 10)
    if (!Number.isFinite(n) || n <= 0) { setDraft(String(pageSize)); return }
    const clamped = Math.min(pageSizeMax, Math.max(1, n))
    if (clamped !== pageSize) onPageSizeChange?.(clamped)
  }

  return (
    <div className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
      {onPageSizeChange && editing ? (
        <input
          type="number"
          autoFocus
          min={1}
          max={pageSizeMax}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur() }
            if (e.key === 'Escape') { setEditing(false); setDraft(String(pageSize)) }
          }}
          className="w-14 border border-purple-300 rounded px-1 py-0.5 text-xs text-center focus:outline-none focus:ring-1 focus:ring-purple-300"
        />
      ) : (
        <span
          className={onPageSizeChange ? 'whitespace-nowrap cursor-pointer hover:text-purple-700 hover:underline' : 'whitespace-nowrap'}
          title={onPageSizeChange ? `Click to change rows per page (max ${pageSizeMax})` : undefined}
          onClick={onPageSizeChange ? () => { setDraft(String(pageSize)); setEditing(true) } : undefined}
        >
          {from}–{to} / {total}
        </span>
      )}
      <button
        onClick={() => page > 1 && onPageChange(page - 1)}
        disabled={page <= 1}
        className="w-6 h-6 flex items-center justify-center border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30 transition-colors"
      >
        ‹
      </button>
      <button
        onClick={() => page < totalPages && onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="w-6 h-6 flex items-center justify-center border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30 transition-colors"
      >
        ›
      </button>
    </div>
  )
}
