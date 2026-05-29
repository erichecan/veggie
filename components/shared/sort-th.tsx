'use client'

export type SortDir = 'asc' | 'desc'

export function SortTh<K extends string>({
  label, sk, cur, dir, onClick, align = 'left',
}: {
  label: string
  sk: K
  cur: K
  dir: SortDir
  onClick: (k: K) => void
  align?: 'left' | 'right' | 'center'
}) {
  const active = cur === sk
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      className={`px-4 py-2.5 ${alignCls} cursor-pointer select-none hover:bg-gray-100 transition-colors whitespace-nowrap`}
      onClick={() => onClick(sk)}
      title={`按「${label}」排序`}
    >
      <span className={active ? 'text-amber-600 font-semibold' : ''}>{label}</span>
      <span className="text-amber-500">{arrow}</span>
    </th>
  )
}

export function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const o = dir === 'asc' ? 1 : -1
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * o
    if (typeof av === 'boolean' && typeof bv === 'boolean') return (Number(av) - Number(bv)) * o
    return String(av).localeCompare(String(bv), 'zh-CN') * o
  })
}
