'use client'

import { cn } from '@/lib/utils'

interface PaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  className?: string
}

/**
 * 通用分页组件
 * - 最多显示 10 个数字页码
 * - 超出时显示省略号（如：1 2 3 … 8 9 10）
 * - 当前页高亮，首末页边界禁用上一页/下一页
 */
export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null

  // 计算最多 10 个可见页码（含省略号位置标记）
  type PageItem = number | 'ellipsis-start' | 'ellipsis-end'

  function getPageItems(): PageItem[] {
    if (totalPages <= 10) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }

    // 左侧省略：当前页靠右
    if (page > totalPages - 5) {
      return [1, 2, 'ellipsis-start', ...range(totalPages - 6, totalPages)]
    }

    // 右侧省略：当前页靠左
    if (page < 6) {
      return [...range(1, 7), 'ellipsis-end', totalPages - 1, totalPages]
    }

    // 两侧都有省略号
    return [1, 2, 'ellipsis-start', ...range(page - 2, page + 2), 'ellipsis-end', totalPages - 1, totalPages]
  }

  function range(start: number, end: number): number[] {
    const result: number[] = []
    for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) result.push(i)
    return result
  }

  const items = getPageItems()

  return (
    <nav
      aria-label="分页导航"
      className={cn('flex items-center justify-center gap-1 mt-4', className)}
    >
      {/* 上一页 */}
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="上一页"
        className={cn(
          'inline-flex items-center justify-center rounded-lg border text-sm font-medium h-8 px-3 transition-colors select-none',
          page <= 1
            ? 'border-gray-200 text-gray-300 cursor-not-allowed'
            : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300',
        )}
      >
        ‹ 上一页
      </button>

      {/* 页码 */}
      {items.map((item, idx) =>
        item === 'ellipsis-start' || item === 'ellipsis-end' ? (
          <span
            key={`${item}-${idx}`}
            className="inline-flex items-center justify-center h-8 w-8 text-gray-400 select-none text-sm"
          >
            …
          </span>
        ) : (
          <button
            key={item}
            onClick={() => onPageChange(item)}
            aria-current={item === page ? 'page' : undefined}
            aria-label={`第 ${item} 页`}
            className={cn(
              'inline-flex items-center justify-center rounded-lg border text-sm font-medium h-8 w-8 transition-colors select-none',
              item === page
                ? 'border-[#875A7B] bg-[#875A7B]/25 text-[#875A7B] font-semibold'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300',
            )}
          >
            {item}
          </button>
        ),
      )}

      {/* 下一页 */}
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="下一页"
        className={cn(
          'inline-flex items-center justify-center rounded-lg border text-sm font-medium h-8 px-3 transition-colors select-none',
          page >= totalPages
            ? 'border-gray-200 text-gray-300 cursor-not-allowed'
            : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300',
        )}
      >
        下一页 ›
      </button>
    </nav>
  )
}
