'use client'
import type { RecordNav } from '@/lib/hooks/use-record-nav'

/** 详情页右上角「N / M ‹ ›」；locked=编辑中(未保存的改动不能被跳走丢掉) */
export default function RecordPager({ nav, onGo, locked, isEn }: {
  nav: RecordNav
  onGo: (id: string) => void
  locked?: boolean
  isEn: boolean
}) {
  const btn = (target: string | null, label: string, title: string) => (
    <button
      type="button"
      title={locked ? (isEn ? 'Save or discard your changes first' : '请先保存或放弃修改') : title}
      disabled={!target || locked}
      onClick={() => { if (target && !locked) onGo(target) }}
      className="h-7 w-7 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-1 text-sm text-gray-500">
      {nav.index >= 0 && <span className="tabular-nums mr-1">{nav.index + 1} / {nav.total}</span>}
      {btn(nav.prevId, '‹', isEn ? 'Previous' : '上一条')}
      {btn(nav.nextId, '›', isEn ? 'Next' : '下一条')}
    </div>
  )
}
