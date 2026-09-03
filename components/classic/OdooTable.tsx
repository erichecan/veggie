'use client'
import React, { useState, useEffect, useRef } from 'react'

/** 把列上的 width / minWidth 翻译成表格单元格样式：width 同时当上限用，避免被表头文字撑开 */
function colSizeStyle(col: { width?: number; minWidth?: number }): React.CSSProperties {
  if (!col.width && !col.minWidth) return {}
  return {
    width: col.width,
    maxWidth: col.width,
    minWidth: col.minWidth ?? col.width,
  }
}

export interface OdooColumn<T = Record<string, unknown>> {
  key: string
  label: string
  sortable?: boolean
  /** text=普通文本搜索, date-range=日期区间, multi-select=列头下拉多选, none=不可筛选 */
  filterType?: 'text' | 'date-range' | 'multi-select' | 'none'
  /** multi-select 列头筛选时，每行用于匹配/分组的值（默认从 row[col.key] 取） */
  filterValueGetter?: (row: T) => string
  /** multi-select 列头筛选时，把原始值映射成展示标签（默认 String(value)） */
  filterLabelGetter?: (value: string, row: T) => string
  /** multi-select 选项固定列表：提供后不再从当前 rows 去重派生（服务端分页场景下 rows 只是当前页，无法枚举全量取值） */
  filterOptions?: { value: string; label: string }[]
  render?: (value: unknown, row: T) => React.ReactNode
  /** 编辑态下用什么类型的输入控件 */
  editType?: 'text' | 'number' | 'select'
  /** editType=select 时使用的下拉选项 */
  editOptions?: { value: string; label: string }[]
  /** 是否支持单击进入编辑态（必须配合 onCellEdit 才生效） */
  editable?: boolean
  /** 列目标宽度(px)。设了就按此宽度收窄：列头允许换行、单元格内容超出换行，不再被表头文字撑开 */
  width?: number
  /** 列最小宽度(px)。给内容会被挤扁的列(名称、描述)留出空间 */
  minWidth?: number
}

interface OdooTableProps<T extends Record<string, unknown>> {
  columns: OdooColumn<T>[]
  rows: T[]
  loading?: boolean
  selected?: Set<string>
  onSelectAll?: (checked: boolean) => void
  onSelectRow?: (id: string, checked: boolean) => void
  onSort?: (key: string) => void
  sortKey?: string
  sortDir?: 'asc' | 'desc'
  rowKey?: string
  onRowClick?: (row: T) => void
  emptyText?: string
  columnFilters?: Record<string, string>
  /** 多选筛选状态：key → 选中的值数组（空数组或 undefined = 全部不过滤） */
  columnMultiFilters?: Record<string, string[]>
  onColumnFilterChange?: (key: string, value: string) => void
  onColumnMultiFilterChange?: (key: string, values: string[]) => void
  /** 是否启用全表的「行内编辑」模式；为 true 时单击 cell 直接进入编辑（再配合 col.editable） */
  inlineEditEnabled?: boolean
  /** 单元格保存回调；返回 Promise，resolve 表示保存成功 */
  onCellEdit?: (row: T, key: string, newValue: unknown) => Promise<void> | void
  /** 行级背景样式（用于告警着色等场景） */
  getRowStyle?: (row: T) => React.CSSProperties | undefined
  /** 按此字段分组，设置后在行间插入分组标题行 */
  groupByField?: string
  /** 自定义分组标题渲染（默认显示字段值 + 数量） */
  groupByFormatter?: (key: string, count: number) => React.ReactNode
}

export default function OdooTable<T extends Record<string, unknown>>({
  columns,
  rows,
  loading = false,
  selected,
  onSelectAll,
  onSelectRow,
  onSort,
  sortKey,
  sortDir,
  rowKey = 'id',
  onRowClick,
  emptyText = '暂无数据',
  columnFilters,
  columnMultiFilters,
  onColumnFilterChange,
  onColumnMultiFilterChange,
  inlineEditEnabled = false,
  onCellEdit,
  getRowStyle,
  groupByField,
  groupByFormatter,
}: OdooTableProps<T>) {
  const showCheckbox = !!onSelectRow && !!selected
  const hasFilters = !!onColumnFilterChange && columns.some(c => c.filterType === 'text' || c.filterType === 'date-range')

  // ─── 列头多选下拉的开关状态 ──
  const [openMultiKey, setOpenMultiKey] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!openMultiKey) return
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenMultiKey(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMultiKey])

  // ─── 单击单元格进入编辑态 ──
  const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null)
  const [editValue, setEditValue] = useState<string>('')
  const [savingCell, setSavingCell] = useState(false)

  function beginEdit(row: T, col: OdooColumn<T>) {
    if (!inlineEditEnabled || !col.editable || !onCellEdit) return
    const id = String(row[rowKey])
    const v = row[col.key]
    setEditing({ rowId: id, key: col.key })
    setEditValue(v == null ? '' : String(v))
  }

  async function commitEdit(row: T, col: OdooColumn<T>) {
    if (!editing || !onCellEdit) return
    const original = row[col.key]
    let newVal: unknown = editValue
    if (col.editType === 'number') {
      const n = Number(editValue)
      newVal = Number.isFinite(n) ? n : original
    }
    if (String(original ?? '') === String(newVal ?? '')) {
      setEditing(null)
      return
    }
    setSavingCell(true)
    try {
      await onCellEdit(row, col.key, newVal)
      setEditing(null)
    } catch {
      // 由调用方 toast，自身不关闭，让用户能修改
    } finally {
      setSavingCell(false)
    }
  }

  function cancelEdit() {
    setEditing(null)
    setSavingCell(false)
  }

  const allSelected = rows.length > 0 && rows.every(r => selected?.has(String(r[rowKey])))
  const someSelected = !allSelected && rows.some(r => selected?.has(String(r[rowKey])))

  // ─── 计算每个 multi-select 列的去重选项 ──
  function getMultiOptions(col: OdooColumn<T>): { value: string; label: string }[] {
    if (col.filterOptions) {
      return [...col.filterOptions].sort((a, b) => a.label.localeCompare(b.label))
    }
    const seen = new Map<string, string>()
    for (const row of rows) {
      const raw = col.filterValueGetter ? col.filterValueGetter(row) : String(row[col.key] ?? '')
      const v = raw ?? ''
      if (seen.has(v)) continue
      const label = col.filterLabelGetter ? col.filterLabelGetter(v, row) : (v === '' ? '（空）' : v)
      seen.set(v, label)
    }
    return Array.from(seen.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  return (
    // 表格常有 50 行 × 十几列，横向撑破视口宽度是常态。此前外层容器高度不设限，
    // 横向滚动条只会出现在"滚完全部行"之后的最底端——早就滚出视口，用户根本看不到、
    // 摸不到，看起来就像"没有滚动条"。这里把容器高度收在视口内、纵向也交给它自己滚，
    // 横向滚动条因此始终贴着可见区域底部，够得着。
    <div
      className="border border-gray-200 rounded bg-white"
      style={{ position: 'relative', overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}
    >
      {loading && rows.length > 0 && (
        <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden rounded-t" style={{ zIndex: 10 }}>
          <div className="h-full w-1/3 animate-pulse" style={{ background: '#875A7B' }} />
        </div>
      )}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e0e0e0' }}>
            {showCheckbox && (
              <th className="w-8 px-2 py-1 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected }}
                  onChange={e => onSelectAll?.(e.target.checked)}
                  className="cursor-pointer"
                  style={{ accentColor: '#875A7B' }}
                />
              </th>
            )}
            {columns.map(col => {
              const activeMulti = (columnMultiFilters?.[col.key]?.length ?? 0) > 0
              const isOpen = openMultiKey === col.key
              return (
                <th
                  key={col.key}
                  className={`px-2 py-1 text-left font-medium text-gray-600 ${col.width ? 'whitespace-normal break-words' : 'whitespace-nowrap'}`}
                  style={{ fontSize: '11px', position: 'relative', ...colSizeStyle(col) }}
                >
                  <div className="flex items-center gap-1">
                    {col.sortable ? (
                      <button
                        onClick={() => onSort?.(col.key)}
                        className="flex items-center gap-1 hover:text-gray-900 transition-colors"
                      >
                        {col.label}
                        <span className="text-gray-400">
                          {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                      </button>
                    ) : (
                      <span>{col.label}</span>
                    )}
                    {col.filterType === 'multi-select' && onColumnMultiFilterChange && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setOpenMultiKey(isOpen ? null : col.key) }}
                        className="ml-0.5 inline-flex items-center justify-center"
                        style={{
                          width: 16, height: 16, borderRadius: 3,
                          background: activeMulti ? '#875A7B' : 'transparent',
                          color: activeMulti ? 'white' : '#9ca3af',
                          fontSize: 10, lineHeight: 1,
                          border: activeMulti ? '1px solid #875A7B' : '1px solid #d1d5db',
                        }}
                        title={activeMulti ? '已筛选，点击修改' : '点击筛选'}
                        aria-label={`筛选 ${col.label}`}
                      >
                        ▼
                      </button>
                    )}
                  </div>
                  {isOpen && col.filterType === 'multi-select' && onColumnMultiFilterChange && (
                    <div
                      ref={popoverRef}
                      className="bg-white border border-gray-200 rounded shadow-lg"
                      // overscrollBehavior: contain 阻止滚动到边界后冒泡到页面
                      // onWheel: 在容器内手动消费滚动，避免某些浏览器（例如 Safari trackpad）忽视
                      //         overscroll-behavior，把页面也卷起来
                      onWheel={e => {
                        const el = e.currentTarget
                        const atTop = el.scrollTop === 0
                        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
                        if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
                          // 已经滚到边界，再继续滚就会冒泡 → 拦下来
                          e.preventDefault()
                          e.stopPropagation()
                        } else {
                          e.stopPropagation()
                        }
                      }}
                      style={{
                        position: 'absolute',
                        top: '100%', left: 0,
                        zIndex: 50,
                        minWidth: 200,
                        maxHeight: 320,
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                        marginTop: 4,
                        padding: '6px 0',
                      }}
                    >
                      <div className="flex items-center justify-between px-3 py-1 border-b border-gray-100">
                        <button
                          type="button"
                          onClick={() => onColumnMultiFilterChange(col.key, [])}
                          className="text-[11px] text-[#875A7B] hover:underline"
                        >
                          全部清除
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpenMultiKey(null)}
                          className="text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          关闭
                        </button>
                      </div>
                      {getMultiOptions(col).map(opt => {
                        const checked = (columnMultiFilters?.[col.key] ?? []).includes(opt.value)
                        return (
                          <label
                            key={opt.value}
                            className="flex items-center gap-2 px-3 py-1 hover:bg-gray-50 cursor-pointer"
                            style={{ fontSize: 12, color: '#374151' }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const current = columnMultiFilters?.[col.key] ?? []
                                const next = checked
                                  ? current.filter(v => v !== opt.value)
                                  : [...current, opt.value]
                                onColumnMultiFilterChange(col.key, next)
                              }}
                              style={{ accentColor: '#875A7B' }}
                            />
                            <span className="truncate">{opt.label}</span>
                          </label>
                        )
                      })}
                      {getMultiOptions(col).length === 0 && (
                        <div className="px-3 py-2 text-[11px] text-gray-400">无可选项</div>
                      )}
                    </div>
                  )}
                </th>
              )
            })}
          </tr>
          {hasFilters && (
            <tr style={{ background: '#fff', borderBottom: '1px solid #e0e0e0' }}>
              {showCheckbox && <td className="w-8 px-2 py-1" />}
              {columns.map(col => (
                <td key={`filter-${col.key}`} className="px-2 py-1 align-top" style={colSizeStyle(col)}>
                  {col.filterType === 'text' && onColumnFilterChange && (
                    <input
                      type="text"
                      value={columnFilters?.[col.key] ?? ''}
                      onChange={e => onColumnFilterChange(col.key, e.target.value)}
                      className="w-full border border-gray-300 rounded bg-white px-1 py-0.5 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-200"
                      style={{ fontSize: '11px' }}
                    />
                  )}
                  {col.filterType === 'date-range' && onColumnFilterChange && (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400 flex-shrink-0" style={{ fontSize: '9px' }}>From:</span>
                        <input
                          type="date"
                          value={columnFilters?.[`${col.key}_from`] ?? ''}
                          onChange={e => onColumnFilterChange(`${col.key}_from`, e.target.value)}
                          className="w-full border border-gray-300 rounded bg-white px-1 py-0.5 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-200"
                          style={{ fontSize: '10px' }}
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400 flex-shrink-0" style={{ fontSize: '9px' }}>To:</span>
                        <input
                          type="date"
                          value={columnFilters?.[`${col.key}_to`] ?? ''}
                          onChange={e => onColumnFilterChange(`${col.key}_to`, e.target.value)}
                          className="w-full border border-gray-300 rounded bg-white px-1 py-0.5 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-200"
                          style={{ fontSize: '10px' }}
                        />
                      </div>
                    </div>
                  )}
                </td>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + (showCheckbox ? 1 : 0)}
                className="px-3 py-8 text-center text-gray-400"
              >
                <div className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-gray-300 rounded-full animate-spin" style={{ borderTopColor: '#875A7B' }} />
                  加载中...
                </div>
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + (showCheckbox ? 1 : 0)}
                className="px-3 py-8 text-center text-gray-400"
              >
                {emptyText}
              </td>
            </tr>
          )}
          {rows.length > 0 && (() => {
            function renderDataRow(row: T, idx: number) {
              const id = String(row[rowKey])
              const isSelected = selected?.has(id) ?? false
              return (
                <tr
                  key={id ?? idx}
                  onClick={() => {
                    if (inlineEditEnabled) return
                    if (editing) return
                    onRowClick?.(row)
                  }}
                  style={{
                    ...getRowStyle?.(row),
                    background: isSelected ? '#ede4f0' : getRowStyle?.(row)?.background,
                    borderBottom: '1px solid #e8e8e8',
                    cursor: onRowClick && !editing && !inlineEditEnabled ? 'pointer' : undefined,
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) (e.currentTarget as HTMLElement).style.background = '#f3eff5'
                  }}
                  onMouseLeave={e => {
                    const base = getRowStyle?.(row)?.background
                    ;(e.currentTarget as HTMLElement).style.background = isSelected ? '#ede4f0' : (typeof base === 'string' ? base : '')
                  }}
                >
                  {showCheckbox && (
                    <td className="w-8 px-2 py-1" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={e => onSelectRow?.(id, e.target.checked)}
                        className="cursor-pointer"
                        style={{ accentColor: '#875A7B' }}
                      />
                    </td>
                  )}
                  {columns.map(col => {
                    const isEditingCell = editing?.rowId === id && editing?.key === col.key
                    const cellEditable = inlineEditEnabled && !!col.editable && !!onCellEdit
                    return (
                      <td
                        key={col.key}
                        className="px-2 py-1 text-gray-700 break-words"
                        style={{
                          ...colSizeStyle(col),
                          background: cellEditable && !isEditingCell ? 'rgba(135, 90, 123, 0.04)' : undefined,
                          outline: isEditingCell ? '2px solid #875A7B' : undefined,
                          cursor: cellEditable && !isEditingCell ? 'cell' : undefined,
                        }}
                        onClick={e => {
                          if (isEditingCell) { e.stopPropagation(); return }
                          if (cellEditable) {
                            e.stopPropagation()
                            beginEdit(row, col)
                          }
                        }}
                        title={cellEditable ? '单击编辑（回车保存 / Esc 取消）' : undefined}
                      >
                        {isEditingCell ? (
                          col.editType === 'select' ? (
                            <select
                              autoFocus
                              value={editValue}
                              disabled={savingCell}
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={() => commitEdit(row, col)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') (e.currentTarget as HTMLSelectElement).blur()
                                if (e.key === 'Escape') cancelEdit()
                              }}
                              className="w-full h-7 px-1 text-sm border border-[#875A7B] rounded bg-white focus:outline-none"
                            >
                              {(col.editOptions ?? []).map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              autoFocus
                              type={col.editType === 'number' ? 'number' : 'text'}
                              step={col.editType === 'number' ? 'any' : undefined}
                              value={editValue}
                              disabled={savingCell}
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={() => commitEdit(row, col)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                                if (e.key === 'Escape') cancelEdit()
                              }}
                              className="w-full h-7 px-1 text-sm border border-[#875A7B] rounded bg-white focus:outline-none"
                            />
                          )
                        ) : (
                          col.render
                            ? col.render(row[col.key], row)
                            : String(row[col.key] ?? '')
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            }

            if (!groupByField) return rows.map((row, idx) => renderDataRow(row, idx))

            const groups = new Map<string, T[]>()
            for (const row of rows) {
              const key = String(row[groupByField] ?? '')
              if (!groups.has(key)) groups.set(key, [])
              groups.get(key)!.push(row)
            }
            const colSpan = columns.length + (showCheckbox ? 1 : 0)
            return Array.from(groups.entries()).flatMap(([key, groupRows]) => [
              <tr key={`__group__${key}`} style={{ background: '#f5f0f7', borderBottom: '2px solid #d4b8d0' }}>
                <td colSpan={colSpan} className="px-3 py-1.5 font-semibold text-sm" style={{ color: '#6d4a66' }}>
                  {groupByFormatter
                    ? groupByFormatter(key, groupRows.length)
                    : <>{key || '（空）'} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({groupRows.length})</span></>}
                </td>
              </tr>,
              ...groupRows.map((row, idx) => renderDataRow(row, idx)),
            ])
          })()}
        </tbody>
      </table>
    </div>
  )
}
