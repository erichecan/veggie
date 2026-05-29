'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'

export interface DrillColumn<T> {
  key: string
  label: string
  align?: 'left' | 'right' | 'center'
  className?: string
  render: (row: T) => ReactNode
}

interface DrillPanelProps<T> {
  title: string
  fullListHref?: string
  fullListLabel?: string
  columns: DrillColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  emptyText?: string
  onClose: () => void
  footer?: ReactNode
  maxHeight?: string
}

export function DrillPanel<T>({
  title,
  fullListHref,
  fullListLabel = '在新页打开完整列表',
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyText = '暂无数据',
  onClose,
  footer,
  maxHeight = '420px',
}: DrillPanelProps<T>) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 overflow-hidden">
      <div
        className="px-5 py-3 border-b border-gray-100 flex items-center gap-3"
        style={{ background: '#f3eff5' }}
      >
        <span className="font-semibold text-gray-800">{title}</span>
        <span className="text-xs text-gray-500">共 {rows.length} 条</span>
        <div className="ml-auto flex items-center gap-3">
          {fullListHref && (
            <Link
              href={fullListHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium hover:underline"
              style={{ color: '#875A7B' }}
            >
              {fullListLabel} →
            </Link>
          )}
          <button
            onClick={onClose}
            aria-label="收起"
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            收起 ✕
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm">{emptyText}</div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight }}>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
              <tr>
                {columns.map(c => (
                  <th
                    key={c.key}
                    className={`px-4 py-2 font-medium text-gray-600 text-xs text-${c.align ?? 'left'} ${c.className ?? ''}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(row => (
                <tr
                  key={rowKey(row)}
                  className={`${onRowClick ? 'cursor-pointer hover:bg-amber-50' : 'hover:bg-gray-50'} transition-colors`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map(c => (
                    <td
                      key={c.key}
                      className={`px-4 py-2 text-${c.align ?? 'left'} ${c.className ?? ''}`}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {footer && (
        <div className="px-5 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          {footer}
        </div>
      )}
    </div>
  )
}
