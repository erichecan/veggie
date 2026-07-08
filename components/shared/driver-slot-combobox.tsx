'use client'
/**
 * DriverSlotCombobox — 可搜索的配送批次/司机选择器
 * -----------------------------------------------------------------------
 * 交互对齐 place-order 选商品:输入关键字(司机名/批次)即时过滤,↑↓ 移动、
 * Enter 选中、Esc 关闭。下拉用 portal + fixed 定位,避免被表格 overflow 裁切。
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { DriverSlotInfo } from '@/lib/driver-slot'

interface Props {
  slots: DriverSlotInfo[]
  value: string                  // 选中的 slotId('' = 未分配)
  onSelect: (slotId: string) => void
  onClose: () => void
}

const slotLabel = (s: DriverSlotInfo) => `${s.batchNum} ${s.timeOfDay} ${s.driverName}`

export function DriverSlotCombobox({ slots, value, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [rect, setRect] = useState<
    { left: number; width: number; maxHeight: number } & (
      | { top: number; bottom?: undefined }
      | { bottom: number; top?: undefined }
    )
  | null>(null)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q ? slots.filter(s => slotLabel(s).toLowerCase().includes(q)) : slots
    const list: { id: string; text: string }[] = matched.map(s => ({ id: s.id, text: slotLabel(s) }))
    if (q === '' || '未分配 unassigned'.includes(q)) list.unshift({ id: '', text: '— 未分配 —' })
    return list
  }, [slots, query])

  const selectedLabel = useMemo(() => {
    const s = slots.find(x => x.id === value)
    return s ? slotLabel(s) : ''
  }, [slots, value])

  useEffect(() => {
    const el = wrapRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const width = Math.max(r.width, 220)
      const gap = 2
      const margin = 8
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      // 下方空间不足且上方更充裕时向上弹出;两种方向都限制 maxHeight 保证不越出视口
      if (spaceBelow < 240 && spaceAbove > spaceBelow) {
        setRect({ left: r.left, bottom: window.innerHeight - r.top + gap, width, maxHeight: Math.max(120, spaceAbove - gap - margin) })
      } else {
        setRect({ left: r.left, top: r.bottom + gap, width, maxHeight: Math.max(120, spaceBelow - gap - margin) })
      }
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  useEffect(() => { setHighlight(0) }, [query])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return
      if (document.getElementById('driver-slot-dropdown')?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  function choose(i: number) {
    const it = items[i]
    if (it) onSelect(it.id)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(highlight) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <span ref={wrapRef} className="inline-block" onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder={selectedLabel || '搜索司机/批次…'}
        className="border border-purple-400 rounded px-1 py-0.5 text-xs bg-white focus:outline-none w-44"
      />
      {rect && createPortal(
        <div
          id="driver-slot-dropdown"
          style={{
            position: 'fixed',
            left: rect.left,
            ...(rect.top !== undefined ? { top: rect.top } : { bottom: rect.bottom }),
            width: rect.width,
            maxHeight: rect.maxHeight,
            zIndex: 60,
          }}
          className="bg-white border border-gray-200 rounded-lg shadow-lg overflow-y-auto text-xs"
          onMouseDown={e => e.preventDefault()}
        >
          {items.length === 0 ? (
            <div className="px-3 py-3 text-gray-400 text-center">无匹配结果</div>
          ) : items.map((it, i) => (
            <div
              key={it.id || '__none__'}
              data-idx={i}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(i)}
              className={`px-3 py-1.5 cursor-pointer whitespace-nowrap ${i === highlight ? 'bg-[#875A7B]/10' : ''} ${it.id === value ? 'text-[#875A7B] font-medium' : 'text-gray-700'}`}
            >
              {it.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}
