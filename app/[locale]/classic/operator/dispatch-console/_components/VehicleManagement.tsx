'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'

type Vehicle = { id: string; plate: string; note: string | null; isActive: boolean }
const PURPLE = '#875A7B'

export default function VehicleManagement() {
  const isEn = useLocale() !== routing.defaultLocale
  const [rows, setRows] = useState<Vehicle[]>([])
  const [plate, setPlate] = useState('')
  const [note, setNote] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPlate, setEditPlate] = useState('')
  const [editNote, setEditNote] = useState('')

  async function load() {
    try {
      const data = await apiGet<Vehicle[]>(`/api/fleet-vehicles${includeInactive ? '?includeInactive=true' : ''}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Failed to load vehicles' : '加载车辆失败'))
    }
  }

  useEffect(() => { load() }, [includeInactive])

  async function addVehicle() {
    if (!plate.trim()) return
    setBusy(true)
    try {
      await apiPost('/api/fleet-vehicles', { plate, note })
      setPlate(''); setNote(''); await load()
      toast.success(isEn ? 'Vehicle added' : '车辆已添加')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Failed to add vehicle' : '添加车辆失败'))
    } finally { setBusy(false) }
  }

  async function saveVehicle(row: Vehicle) {
    if (!editPlate.trim()) return
    setBusy(true)
    try { await apiPut(`/api/fleet-vehicles/${row.id}`, { plate: editPlate, note: editNote }); setEditingId(null); await load(); toast.success(isEn ? 'Vehicle updated' : '车辆已更新') }
    catch (error) { toast.error(error instanceof Error ? error.message : (isEn ? 'Failed to update vehicle' : '更新车辆失败')) }
    finally { setBusy(false) }
  }

  async function toggleActive(row: Vehicle) {
    setBusy(true)
    try {
      if (row.isActive) await apiDelete(`/api/fleet-vehicles/${row.id}`)
      else await apiPut(`/api/fleet-vehicles/${row.id}`, { plate: row.plate, note: row.note, isActive: true })
      await load()
    } catch (error) { toast.error(error instanceof Error ? error.message : (isEn ? 'Failed to update vehicle' : '更新车辆失败')) }
    finally { setBusy(false) }
  }

  return <section className="space-y-4">
    <div>
      <h2 className="text-base font-semibold" style={{ color: PURPLE }}>{isEn ? 'Vehicle Management' : '车辆管理'}</h2>
      <p className="mt-1 text-sm text-gray-500">{isEn ? 'Register fleet plates once, then search and select them when assigning a delivery.' : '先在这里登记车牌，安排配送时即可输入部分车牌字符并选择匹配车辆。'}</p>
    </div>
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
      <label className="min-w-48 flex-1 text-xs text-gray-500">{isEn ? 'Registration plate' : '车牌号'}
        <input value={plate} maxLength={24} onChange={e => setPlate(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') addVehicle() }} placeholder={isEn ? 'e.g. 241-D-12345' : '例如：241-D-12345'} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
      </label>
      <label className="min-w-48 flex-1 text-xs text-gray-500">{isEn ? 'Note (optional)' : '备注（选填）'}
        <input value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addVehicle() }} placeholder={isEn ? 'Vehicle details' : '车辆说明'} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
      </label>
      <button disabled={busy || !plate.trim()} onClick={addVehicle} className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: PURPLE }}>{isEn ? 'Add vehicle' : '添加车辆'}</button>
    </div>
    <label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />{isEn ? 'Show inactive vehicles' : '显示已停用车辆'}</label>
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-[#faf5fb] text-xs" style={{ color: PURPLE }}><tr><th className="p-3 text-left">{isEn ? 'Registration plate' : '车牌号'}</th><th className="p-3 text-left">{isEn ? 'Note' : '备注'}</th><th className="p-3 text-left">{isEn ? 'Status' : '状态'}</th><th className="p-3 text-right">{isEn ? 'Actions' : '操作'}</th></tr></thead>
        <tbody className="divide-y">{rows.map(row => <tr key={row.id} className={!row.isActive ? 'text-gray-400' : ''}>
          <td className="p-3 font-medium">{editingId === row.id ? <input autoFocus value={editPlate} maxLength={24} onChange={e => setEditPlate(e.target.value.toUpperCase())} className="w-full rounded border px-2 py-1" /> : row.plate}</td>
          <td className="p-3">{editingId === row.id ? <input value={editNote} onChange={e => setEditNote(e.target.value)} className="w-full rounded border px-2 py-1" /> : row.note || '—'}</td>
          <td className="p-3">{row.isActive ? (isEn ? 'Active' : '启用') : (isEn ? 'Inactive' : '停用')}</td>
          <td className="p-3 text-right">{editingId === row.id ? <><button disabled={busy} onClick={() => saveVehicle(row)} className="mr-3 text-[#714B67] disabled:opacity-50">{isEn ? 'Save' : '保存'}</button><button disabled={busy} onClick={() => setEditingId(null)} className="mr-3 text-gray-500 disabled:opacity-50">{isEn ? 'Cancel' : '取消'}</button></> : <button disabled={busy} onClick={() => { setEditingId(row.id); setEditPlate(row.plate); setEditNote(row.note ?? '') }} className="mr-3 text-[#714B67] disabled:opacity-50">{isEn ? 'Edit' : '编辑'}</button>}<button disabled={busy} onClick={() => toggleActive(row)} className="text-gray-500 disabled:opacity-50">{row.isActive ? (isEn ? 'Disable' : '停用') : (isEn ? 'Restore' : '恢复')}</button></td>
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className="p-8 text-center text-sm text-gray-400">{isEn ? 'No vehicles registered' : '暂无车辆，请先添加车牌'}</p>}
    </div>
  </section>
}
