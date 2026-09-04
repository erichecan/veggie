'use client'
import { dupKey, type DupKeyLine } from '@/lib/sale-uom'

const PURPLE = '#875A7B'

/**
 * "重复商品提醒"横幅——同一商品+同一单位在编辑缓冲区里出现了不止一行时显示，
 * 点「合并重复项」交给调用方的 onMerge 处理（各页自己的 mergeDuplicateLines 调用）。
 *
 * 三个订单页原先各自复制了一份逐字/近逐字相同的 JSX，20260904 收口到这一处——
 * 详见 lib/sale-uom.ts 顶部同一批改动的说明。判重本身不在这里做：`duplicateCounts`
 * 由调用方算好传进来，因为页面里给单条行加高亮（isDuplicate）也要用同一份 Map，
 * 不该算两遍。
 */
export function DuplicateProductAlert<T extends DupKeyLine & { productName?: string | null }>({
  lines,
  duplicateCounts,
  isEn,
  onMerge,
}: {
  lines: T[]
  duplicateCounts: Map<string, number>
  isEn: boolean
  onMerge: () => void
}) {
  const dups = [...duplicateCounts.entries()].filter(([, c]) => c > 1)
  if (dups.length === 0) return null
  const nameOf = (key: string) => lines.find(l => dupKey(l) === key)?.productName ?? key

  return (
    <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-start gap-3">
      <span className="text-lg leading-none mt-0.5">🔁</span>
      <div className="text-sm flex-1">
        <span className="font-semibold text-purple-700">{isEn ? 'Duplicate product alert: ' : '重复商品提醒：'}</span>
        <span className="text-purple-600">
          {isEn ? `${dups.length} product(s) added more than once` : `${dups.length} 个商品被重复添加`}
          <span className="text-xs text-purple-500 ml-1">
            ({dups.map(([key, c]) => `${nameOf(key)} ×${c}`).join(isEn ? ', ' : '、')})
          </span>
        </span>
        <span className="text-xs text-gray-500 ml-1">
          {isEn
            ? '— click "Merge" on the right to combine into one line (quantities added), or leave as-is and adjust manually'
            : '— 可点右侧「合并」合并为一行（数量相加），或保留现状手动调整'}
        </span>
      </div>
      <button
        onClick={onMerge}
        className="shrink-0 px-3 py-1 rounded text-xs font-medium text-white"
        style={{ background: PURPLE }}
      >
        {isEn ? 'Merge Duplicates' : '合并重复项'}
      </button>
    </div>
  )
}
