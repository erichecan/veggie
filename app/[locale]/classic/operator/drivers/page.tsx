'use client'
import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface DriverSlot {
  id: string
  timeOfDay: string
  batchNum: number
  driverName: string
  userId?: string | null
  archived: boolean
}

interface DraftRow {
  id: string | null
  timeOfDay: string
  batchNum: string
  driverName: string
  userId: string
  editing: boolean
  dirty: boolean
  original?: { timeOfDay: string; batchNum: string; driverName: string }
}

const BATCH_OPTIONS = [1, 2, 3, 4, 5]

function rowKey(r: DraftRow) { return r.id ?? `new-${Date.now()}` }

export default function DriversPage() {
  const [rows, setRows] = useState<DraftRow[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [archivedRows, setArchivedRows] = useState<DriverSlot[]>([])
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [archiving, setArchiving] = useState<Record<string, boolean>>({})
  const [driverUsers, setDriverUsers] = useState<{ id: string; name: string }[]>([])
  const newNameRef = useRef<HTMLInputElement>(null)

  type SortKey = 'timeOfDay' | 'batchNum' | 'driverName'
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterTime, setFilterTime] = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [filterName, setFilterName] = useState('')

  function toggleSort(key: SortKey) {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null)
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return <span className="text-gray-300">⇅</span>
    return <span>{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  async function load() {
    try {
      const data = await apiGet<DriverSlot[]>('/api/driver-slots')
      setRows(
        data.map(s => ({
          id: s.id,
          timeOfDay: s.timeOfDay,
          batchNum: String(s.batchNum),
          driverName: s.driverName,
          userId: s.userId ?? '',
          editing: false,
          dirty: false,
        }))
      )
    } catch {
      toast.error('加载失败')
    }
  }

  async function loadDriverUsers() {
    try {
      const us = await apiGet<{ id: string; name: string }[]>('/api/users?role=DRIVER')
      setDriverUsers(Array.isArray(us) ? us : [])
    } catch { /* ignore */ }
  }

  async function loadArchived() {
    try {
      const data = await apiGet<DriverSlot[]>('/api/driver-slots?archived=true')
      setArchivedRows(data)
    } catch {
      toast.error('加载归档数据失败')
    }
  }

  useEffect(() => { load(); loadDriverUsers() }, [])
  useEffect(() => { if (showArchived) loadArchived() }, [showArchived])

  function addRow() {
    setRows(prev => [
      ...prev,
      { id: null, timeOfDay: 'am', batchNum: '1', driverName: '', userId: '', editing: true, dirty: true },
    ])
    setTimeout(() => newNameRef.current?.focus(), 50)
  }

  function startEdit(idx: number) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      return { ...r, editing: true, original: { timeOfDay: r.timeOfDay, batchNum: r.batchNum, driverName: r.driverName } }
    }))
  }

  function discardEdit(idx: number) {
    const row = rows[idx]
    if (!row.id) {
      setRows(prev => prev.filter((_, i) => i !== idx))
      return
    }
    if (row.original) {
      setRows(prev => prev.map((r, i) => i === idx
        ? { ...r, ...r.original, editing: false, dirty: false, original: undefined }
        : r
      ))
    } else {
      setRows(prev => prev.map((r, i) => i === idx ? { ...r, editing: false, dirty: false } : r))
    }
  }

  function updateRow(idx: number, field: string, value: string) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value, dirty: true } : r))
  }

  async function saveRow(idx: number) {
    const row = rows[idx]
    if (!row.driverName.trim()) { toast.error('请填写司机名字'); return }
    const key = row.id ?? `new-${idx}`
    setSaving(s => ({ ...s, [key]: true }))
    try {
      const body = {
        timeOfDay: row.timeOfDay,
        batchNum: Number(row.batchNum),
        driverName: row.driverName.trim(),
        userId: row.userId || null,
      }
      if (row.id) {
        const updated = await apiPut<DriverSlot>(`/api/driver-slots/${row.id}`, body)
        setRows(prev => prev.map((r, i) => i === idx
          ? { id: updated.id, timeOfDay: updated.timeOfDay, batchNum: String(updated.batchNum), driverName: updated.driverName, userId: updated.userId ?? '', editing: false, dirty: false }
          : r
        ))
      } else {
        const created = await apiPost<DriverSlot>('/api/driver-slots', body)
        setRows(prev => prev.map((r, i) => i === idx
          ? { id: created.id, timeOfDay: created.timeOfDay, batchNum: String(created.batchNum), driverName: created.driverName, userId: created.userId ?? '', editing: false, dirty: false }
          : r
        ))
      }
      toast.success('已保存')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg.includes('409') || msg.includes('已存在') || msg.includes('相同时段') ? '该司机已在相同时段和批次中' : '保存失败')
    } finally {
      setSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function archiveRow(idx: number) {
    const row = rows[idx]
    if (!row.id) { setRows(prev => prev.filter((_, i) => i !== idx)); return }
    const key = row.id
    setArchiving(a => ({ ...a, [key]: true }))
    try {
      await apiPut(`/api/driver-slots/${row.id}`, { archived: true })
      setRows(prev => prev.filter((_, i) => i !== idx))
      toast.success('已归档')
      if (showArchived) loadArchived()
    } catch {
      toast.error('归档失败')
    } finally {
      setArchiving(a => ({ ...a, [key]: false }))
    }
  }

  async function restoreRow(id: string) {
    setArchiving(a => ({ ...a, [id]: true }))
    try {
      await apiPut(`/api/driver-slots/${id}`, { archived: false })
      setArchivedRows(prev => prev.filter(r => r.id !== id))
      toast.success('已恢复')
      load()
    } catch {
      toast.error('恢复失败')
    } finally {
      setArchiving(a => ({ ...a, [id]: false }))
    }
  }

  const inputCls = 'border rounded px-2 py-1.5 text-sm outline-none focus:ring-1 w-full'
  const inputStyle = { borderColor: BORDER }
  const focusStyle = { '--tw-ring-color': PURPLE } as React.CSSProperties
  const hasDirty = rows.some(r => r.dirty)

  const displayed = rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      if (row.editing) return true
      if (filterTime && row.timeOfDay !== filterTime) return false
      if (filterBatch && row.batchNum !== filterBatch) return false
      if (filterName && !row.driverName.toLowerCase().includes(filterName.toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      if (!sortKey) return 0
      let cmp = 0
      if (sortKey === 'batchNum') cmp = Number(a.row.batchNum) - Number(b.row.batchNum)
      else if (sortKey === 'timeOfDay') cmp = a.row.timeOfDay.localeCompare(b.row.timeOfDay)
      else cmp = a.row.driverName.localeCompare(b.row.driverName, 'zh')
      return sortDir === 'asc' ? cmp : -cmp
    })

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400">设置</p>
          <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>司机配置</h1>
        </div>
        <div className="flex gap-2 items-center">
          {hasDirty && (
            <>
              <button
                onClick={() => { rows.forEach((r, i) => { if (r.dirty) saveRow(i) }) }}
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: '#21a67a' }}
              >
                保存
              </button>
              <button
                onClick={() => { rows.forEach((_, i) => { if (rows[i].dirty) discardEdit(i) }) }}
                className="px-3 py-1.5 rounded text-sm font-medium border"
                style={{ borderColor: BORDER, color: '#666' }}
              >
                放弃
              </button>
            </>
          )}
          <button
            onClick={addRow}
            className="px-4 py-1.5 rounded text-sm font-medium text-white"
            style={{ background: PURPLE }}
          >
            + 新增
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        {/* Table header */}
        <div className="grid grid-cols-[110px_80px_1fr_170px_auto] gap-3 px-4 py-2.5 text-xs font-semibold border-b" style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb' }}>
          <button type="button" onClick={() => toggleSort('timeOfDay')} className="flex items-center gap-1 text-left hover:opacity-70">
            时段（上午/下午）{sortArrow('timeOfDay')}
          </button>
          <button type="button" onClick={() => toggleSort('batchNum')} className="flex items-center gap-1 text-left hover:opacity-70">
            批次编号{sortArrow('batchNum')}
          </button>
          <button type="button" onClick={() => toggleSort('driverName')} className="flex items-center gap-1 text-left hover:opacity-70">
            司机名字{sortArrow('driverName')}
          </button>
          <span>绑定系统用户</span>
          <span className="w-32" />
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-[110px_80px_1fr_170px_auto] gap-3 px-4 py-2 border-b items-center" style={{ borderColor: '#f0e4ee', background: '#fdfbfd' }}>
          <select
            value={filterTime}
            onChange={e => setFilterTime(e.target.value)}
            className="border rounded px-2 py-1 text-xs outline-none focus:ring-1 w-full"
            style={{ ...inputStyle, ...focusStyle }}
          >
            <option value="">全部时段</option>
            <option value="am">上午</option>
            <option value="pm">下午</option>
          </select>
          <select
            value={filterBatch}
            onChange={e => setFilterBatch(e.target.value)}
            className="border rounded px-2 py-1 text-xs outline-none focus:ring-1 w-full"
            style={{ ...inputStyle, ...focusStyle }}
          >
            <option value="">全部</option>
            {BATCH_OPTIONS.map(n => <option key={n} value={String(n)}>{n}</option>)}
          </select>
          <input
            type="text"
            value={filterName}
            onChange={e => setFilterName(e.target.value)}
            placeholder="搜索司机名字…"
            className="border rounded px-2 py-1 text-xs outline-none focus:ring-1 w-full"
            style={{ ...inputStyle, ...focusStyle }}
          />
          <span />
          <div className="w-32 flex justify-end">
            {(filterTime || filterBatch || filterName || sortKey) && (
              <button
                type="button"
                onClick={() => { setFilterTime(''); setFilterBatch(''); setFilterName(''); setSortKey(null) }}
                className="px-2 py-1 rounded text-xs font-medium border"
                style={{ borderColor: BORDER, color: '#666' }}
              >
                清除
              </button>
            )}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">
            暂无司机配置，点击「新增」添加
          </div>
        )}

        {rows.length > 0 && displayed.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">
            无匹配结果
          </div>
        )}

        {displayed.map(({ row, idx }) => {
          const key = row.id ?? `new-${idx}`
          const isSaving = saving[key]
          const isArchiving = archiving[key]

          return (
            <div
              key={key}
              className="grid grid-cols-[110px_80px_1fr_170px_auto] gap-3 items-center px-4 py-3 border-b last:border-b-0"
              style={{ borderColor: '#f0e4ee', background: row.dirty ? '#fffbfe' : '#fff' }}
              onDoubleClick={() => { if (!row.editing) startEdit(idx) }}
            >
              {/* 时段 */}
              {row.editing ? (
                <select
                  value={row.timeOfDay}
                  onChange={e => updateRow(idx, 'timeOfDay', e.target.value)}
                  className={inputCls}
                  style={{ ...inputStyle, ...focusStyle }}
                >
                  <option value="am">上午（am）</option>
                  <option value="pm">下午（pm）</option>
                </select>
              ) : (
                <span className="text-sm px-2 py-1.5">{row.timeOfDay === 'am' ? '上午' : '下午'}</span>
              )}

              {/* 批次编号 */}
              {row.editing ? (
                <select
                  value={row.batchNum}
                  onChange={e => updateRow(idx, 'batchNum', e.target.value)}
                  className={inputCls}
                  style={{ ...inputStyle, ...focusStyle }}
                >
                  {BATCH_OPTIONS.map(n => (
                    <option key={n} value={String(n)}>{n}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm px-2 py-1.5">{row.batchNum}</span>
              )}

              {/* 司机名字 */}
              {row.editing ? (
                <input
                  ref={!row.id ? newNameRef : undefined}
                  type="text"
                  value={row.driverName}
                  onChange={e => updateRow(idx, 'driverName', e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveRow(idx) }}
                  placeholder="输入司机名字"
                  className={inputCls}
                  style={{ ...inputStyle, ...focusStyle }}
                />
              ) : (
                <span className="text-sm px-2 py-1.5 font-medium">{row.driverName}</span>
              )}

              {/* 绑定系统用户(P0-2/A2):配送出发建 Trip 取此 userId 作司机身份 */}
              {row.editing ? (
                <select
                  value={row.userId}
                  onChange={e => updateRow(idx, 'userId', e.target.value)}
                  className={inputCls}
                  style={{ ...inputStyle, ...focusStyle }}
                >
                  <option value="">— 未绑定 —</option>
                  {driverUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm px-2 py-1.5" style={{ color: row.userId ? '#333' : '#c00' }}>
                  {row.userId ? (driverUsers.find(u => u.id === row.userId)?.name ?? '(已绑定)') : '未绑定 ⚠'}
                </span>
              )}

              {/* 操作按钮 */}
              <div className="flex gap-1.5 w-32 justify-end">
                {row.editing ? (
                  <>
                    <button
                      onClick={() => saveRow(idx)}
                      disabled={isSaving}
                      className="px-2.5 py-1 rounded text-xs font-medium text-white disabled:opacity-50"
                      style={{ background: '#21a67a' }}
                    >
                      {isSaving ? '...' : '保存'}
                    </button>
                    <button
                      onClick={() => discardEdit(idx)}
                      className="px-2.5 py-1 rounded text-xs font-medium border"
                      style={{ borderColor: '#d1d5db', color: '#666' }}
                    >
                      放弃
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => startEdit(idx)}
                      className="px-2.5 py-1 rounded text-xs font-medium"
                      style={{ color: PURPLE }}
                    >
                      修改
                    </button>
                    <button
                      onClick={() => archiveRow(idx)}
                      disabled={isArchiving}
                      className="px-2 py-1 rounded text-xs font-medium text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-50"
                    >
                      {isArchiving ? '...' : '归档'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 归档区域 */}
      <div className="pt-2">
        <button
          onClick={() => setShowArchived(!showArchived)}
          className="text-xs font-medium underline"
          style={{ color: PURPLE }}
        >
          {showArchived ? '隐藏归档司机' : '查看归档司机'}
        </button>

        {showArchived && (
          <div className="mt-3 bg-gray-50 rounded-lg border overflow-hidden" style={{ borderColor: '#e5e7eb' }}>
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 border-b bg-gray-100">
              已归档司机（{archivedRows.length}）
            </div>
            {archivedRows.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">无归档记录</div>
            ) : (
              archivedRows.map(slot => (
                <div key={slot.id} className="flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 text-sm text-gray-500">
                  <span>{slot.timeOfDay === 'am' ? '上午' : '下午'} · 批次 {slot.batchNum} · {slot.driverName}</span>
                  <button
                    onClick={() => restoreRow(slot.id)}
                    disabled={archiving[slot.id]}
                    className="px-3 py-1 rounded text-xs font-medium text-white disabled:opacity-50"
                    style={{ background: PURPLE }}
                  >
                    {archiving[slot.id] ? '...' : '恢复'}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <p className="text-xs text-gray-400">
          双击行可进入编辑模式 · 批次格式：批次编号 + 时段 + 司机名 → 例如「1 am BAO」
        </p>
      )}
    </div>
  )
}
