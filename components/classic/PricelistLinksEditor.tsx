'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * 客户列表 Edit 模式下「价格表」一格的编辑面板（20261023 客户需求：列表里直接
 * 增加 / 减少 / 替换客户挂的价格表）。以前这一格只能换「主价格表」(排第一的那个)，
 * 而且点文字弹出的是只读浮层、点空白才进编辑，进编辑后整张表还会重新排版、列位错开。
 *
 * - 列表顺序 = 优先级（1 最高，同 CustomerPricelist.sequence），可上移/下移
 * - 点某一行的名字 = 替换成别的价格表；× = 移除；底部「添加价格表」= 追加到最后
 * - 改完点「保存」才提交（整组 pricelistIds 一次 PUT），「取消」/Esc 放弃
 *
 * 搜索下拉放在面板里正常排版，不用 position: fixed——面板本身是浮层(带 transform 动画)，
 * fixed 子元素会相对它定位而错位。
 */
export interface PricelistOption { value: string; label: string }

interface Props {
  /** 当前挂的价格表 id，按优先级排好 */
  value: string[]
  /** 可选的价格表（启用且 selectable 的） */
  options: PricelistOption[]
  /** id → 名称；已归档/不可选的老价格表也要能显示名字 */
  nameOf: (id: string) => string
  isEn: boolean
  onSave: (ids: string[]) => Promise<void>
  onClose: () => void
}

export default function PricelistLinksEditor({ value, options, nameOf, isEn, onSave, onClose }: Props) {
  const [ids, setIds] = useState<string[]>(value)
  /** 正在挑选的位置：数字 = 替换第几行，'add' = 新增，null = 没在挑 */
  const [picking, setPicking] = useState<number | 'add' | null>(value.length === 0 ? 'add' : null)
  const [saving, setSaving] = useState(false)
  const dirty = ids.length !== value.length || ids.some((id, i) => id !== value[i])

  function pick(id: string) {
    if (picking === 'add') setIds(prev => [...prev, id])
    else if (typeof picking === 'number') setIds(prev => prev.map((x, i) => (i === picking ? id : x)))
    setPicking(null)
  }

  function move(i: number, step: -1 | 1) {
    setIds(prev => {
      const j = i + step
      if (j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    try {
      await onSave(ids)
      onClose()
    } catch {
      // 失败提示由 onSave 负责；面板保持打开，改动不丢
    } finally {
      setSaving(false)
    }
  }

  // 挑选时排除已挂上的（替换时当前这一行自己除外），同一价格表不能挂两次
  const taken = new Set(ids.filter((_, i) => i !== picking))
  const pickOptions = options.filter(o => !taken.has(o.value))

  const iconBtn = 'w-6 h-6 inline-flex items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div
      className="flex flex-col gap-2 text-sm"
      onKeyDown={e => {
        if (e.key === 'Escape' && picking === null) { e.preventDefault(); onClose() }
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{isEn ? 'Applied Pricelists' : '挂靠的价格表'}</span>
        <span className="text-[11px] text-gray-400">{isEn ? '1 = highest priority' : '1 = 优先级最高'}</span>
      </div>

      {ids.length === 0 && picking !== 'add' && (
        <div className="text-gray-400 text-xs py-1">{isEn ? 'No pricelist — list price applies' : '未挂价格表（按牌价）'}</div>
      )}

      <ul className="flex flex-col gap-1">
        {ids.map((id, i) => (
          <li key={`${id}-${i}`} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-gray-400 w-4 shrink-0 text-right">{i + 1}.</span>
              <button
                type="button"
                onClick={() => setPicking(picking === i ? null : i)}
                title={isEn ? 'Click to replace' : '点击替换'}
                className={`flex-1 min-w-0 text-left truncate px-1.5 py-0.5 rounded border ${picking === i ? 'border-[#875A7B] bg-[#f3eff5]' : 'border-transparent hover:border-gray-300'}`}
              >
                {nameOf(id)}
              </button>
              <button type="button" className={iconBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={isEn ? 'Move up' : '上移'} title={isEn ? 'Move up' : '上移'}>↑</button>
              <button type="button" className={iconBtn} disabled={i === ids.length - 1} onClick={() => move(i, 1)} aria-label={isEn ? 'Move down' : '下移'} title={isEn ? 'Move down' : '下移'}>↓</button>
              <button
                type="button"
                className={`${iconBtn} hover:!text-red-600`}
                onClick={() => { setIds(prev => prev.filter((_, k) => k !== i)); setPicking(null) }}
                aria-label={isEn ? `Remove ${nameOf(id)}` : `移除 ${nameOf(id)}`}
                title={isEn ? 'Remove' : '移除'}
              >×</button>
            </div>
            {picking === i && (
              <PickList options={pickOptions} isEn={isEn} onPick={pick} onCancel={() => setPicking(null)} />
            )}
          </li>
        ))}
      </ul>

      {picking === 'add' ? (
        <PickList options={pickOptions} isEn={isEn} onPick={pick} onCancel={() => setPicking(null)} />
      ) : (
        <button
          type="button"
          onClick={() => setPicking('add')}
          disabled={pickOptions.length === 0}
          className="self-start text-[13px] text-[#875A7B] hover:underline disabled:text-gray-300 disabled:no-underline"
        >
          + {isEn ? 'Add pricelist' : '添加价格表'}
        </button>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <button type="button" onClick={onClose} className="h-7 px-3 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
          {isEn ? 'Cancel' : '取消'}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="h-7 px-3 rounded text-white disabled:opacity-50"
          style={{ background: '#875A7B' }}
        >
          {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
        </button>
      </div>
    </div>
  )
}

/** 面板内的可搜索列表：打字筛选，↑/↓ 循环高亮，Enter 选中，Esc 退出挑选 */
function PickList({ options, isEn, onPick, onCancel }: {
  options: PricelistOption[]
  isEn: boolean
  onPick: (id: string) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  return (
    <div className="flex flex-col border border-[#875A7B] rounded overflow-hidden">
      <input
        ref={inputRef}
        value={query}
        placeholder={isEn ? 'Search pricelist…' : '搜索价格表…'}
        onChange={e => { setQuery(e.target.value); setHighlight(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (filtered.length === 0) return
            const step = e.key === 'ArrowDown' ? 1 : -1
            setHighlight(h => (h + step + filtered.length) % filtered.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const opt = filtered[highlight]
            if (opt) onPick(opt.value)
          } else if (e.key === 'Escape') {
            // 只退出挑选，不关整个面板
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        className="h-7 px-2 text-sm border-b border-gray-200 focus:outline-none"
      />
      <div ref={listRef} role="listbox" className="max-h-48 overflow-y-auto py-1">
        {filtered.length === 0 && <div className="px-2 py-1 text-gray-400">{isEn ? 'No match' : '没有匹配项'}</div>}
        {filtered.map((o, idx) => (
          <div
            key={o.value}
            data-idx={idx}
            role="option"
            aria-selected={idx === highlight}
            onMouseEnter={() => setHighlight(idx)}
            onMouseDown={e => { e.preventDefault(); onPick(o.value) }}
            className={`px-2 py-1 cursor-pointer truncate ${idx === highlight ? 'bg-[#f3eff5] text-[#6d4a66]' : 'text-gray-700'}`}
          >
            {o.label}
          </div>
        ))}
      </div>
    </div>
  )
}
