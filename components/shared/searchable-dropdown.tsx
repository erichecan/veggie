'use client'
/**
 * SearchableDropdown - 可搜索下拉组件，支持键盘导航
 * -----------------------------------------------------------------------
 * 功能：
 *   - 打开下拉后第一个选项自动高亮
 *   - ↑↓ 键移动高亮
 *   - Enter 键选中当前高亮选项
 *   - Escape 键关闭下拉
 *   - 鼠标 hover 也会移动高亮
 *   - 外部点击关闭
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export interface DropdownOption {
  value: string
  label: string
  sublabel?: string
}

interface SearchableDropdownProps {
  options: DropdownOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  className?: string
  maxHeight?: string
}

export function SearchableDropdown({
  options,
  value,
  onChange,
  placeholder = '-- 请选择 --',
  searchPlaceholder = '搜索…',
  disabled = false,
  className = '',
  maxHeight = 'max-h-56',
}: SearchableDropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = options.filter(opt =>
    opt.label.toLowerCase().includes(search.toLowerCase()) ||
    (opt.sublabel ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  const selectedOption = options.find(o => o.value === value)

  // Reset highlight to 0 when filter changes, and scroll into view
  useEffect(() => {
    setHighlightIdx(0)
  }, [search])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const item = list.querySelector(`[data-idx="${highlightIdx}"]`) as HTMLElement | null
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, open])

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // Auto-focus search input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 10)
    } else {
      setSearch('')
      setHighlightIdx(0)
    }
  }, [open])

  const selectOption = useCallback((opt: DropdownOption) => {
    onChange(opt.value)
    setOpen(false)
    setSearch('')
    setHighlightIdx(0)
  }, [onChange])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIdx(i => Math.min(i + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIdx(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[highlightIdx]) selectOption(filtered[highlightIdx])
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
    }
  }

  return (
    <div ref={containerRef} className={`relative ${className}`} onKeyDown={handleKeyDown}>
      {/* Trigger */}
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && setOpen(o => !o)}
        className={`border rounded-lg px-3 py-2 text-sm flex items-center justify-between cursor-pointer bg-white transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'hover:border-gray-400'}
          ${open ? 'ring-2 ring-green-500/40 border-green-500' : 'border-gray-300'}
        `}
      >
        <span className={selectedOption ? 'text-gray-900' : 'text-gray-400'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span className="text-gray-400 text-xs ml-2 flex-shrink-0">▾</span>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
          {/* Search input */}
          <div className="p-2 border-b border-gray-100">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-green-500/40 focus:border-green-500"
              onClick={e => e.stopPropagation()}
            />
          </div>

          {/* Options list */}
          <div ref={listRef} className={`${maxHeight} overflow-y-auto`} role="listbox">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">无匹配结果</div>
            ) : (
              filtered.map((opt, idx) => (
                <div
                  key={opt.value}
                  data-idx={idx}
                  role="option"
                  aria-selected={opt.value === value}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => selectOption(opt)}
                  className={`px-3 py-2 text-sm cursor-pointer transition-colors
                    ${idx === highlightIdx ? 'bg-green-50' : ''}
                    ${opt.value === value ? 'text-green-700 font-medium' : 'text-gray-700'}
                    hover:bg-green-50
                  `}
                >
                  <div>{opt.label}</div>
                  {opt.sublabel && (
                    <div className="text-xs text-gray-400 mt-0.5">{opt.sublabel}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
