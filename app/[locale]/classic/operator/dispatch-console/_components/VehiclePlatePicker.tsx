'use client'
import { useEffect, useMemo, useState } from 'react'

export type FleetVehicleOption = { id: string; plate: string; note?: string | null; isActive: boolean }

export default function VehiclePlatePicker({
  value, vehicles, disabled, isEn, onSelect,
}: {
  value: string | null | undefined
  vehicles: FleetVehicleOption[]
  disabled?: boolean
  isEn: boolean
  onSelect: (plate: string) => void
}) {
  const [query, setQuery] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  useEffect(() => { setQuery(value ?? '') }, [value])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return vehicles.filter(v => !q || `${v.plate} ${v.note ?? ''}`.toLowerCase().includes(q)).slice(0, 8)
  }, [query, vehicles])

  return <div className="relative mt-1 w-36">
    <input
      aria-label={isEn ? 'Vehicle registration plate' : '车辆车牌'}
      role="combobox" aria-expanded={open} aria-autocomplete="list"
      value={query} disabled={disabled} maxLength={24}
      placeholder={isEn ? 'Search plate…' : '输入车牌搜索'}
      className="w-full rounded border p-1.5 text-xs disabled:bg-gray-50"
      onFocus={() => setOpen(true)}
      onChange={e => { setQuery(e.target.value.toUpperCase()); setOpen(true) }}
      onBlur={() => { window.setTimeout(() => setOpen(false), 120); setQuery(value ?? '') }}
      onKeyDown={e => {
        if (e.key === 'Escape') { setQuery(value ?? ''); setOpen(false) }
        if (e.key === 'Enter' && matches.length === 1) { e.preventDefault(); onSelect(matches[0].plate); setQuery(matches[0].plate); setOpen(false) }
      }}
    />
    {open && !disabled && <div role="listbox" className="absolute left-0 top-full z-30 mt-1 max-h-48 w-56 overflow-y-auto rounded border bg-white py-1 shadow-lg">
      {matches.map(vehicle => <button key={vehicle.id} type="button" role="option" aria-selected={vehicle.plate === value}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { onSelect(vehicle.plate); setQuery(vehicle.plate); setOpen(false) }}
        className="block w-full px-3 py-2 text-left text-xs hover:bg-purple-50">
        <span className="font-medium">{vehicle.plate}</span>{vehicle.note && <span className="ml-2 text-gray-400">{vehicle.note}</span>}
      </button>)}
      {matches.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">{isEn ? 'No match. Add this vehicle in Driver Config → Vehicle Management.' : '没有匹配车牌，请到“司机配置 → 车辆管理”添加车辆。'}</p>}
      {value && <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onSelect(''); setQuery(''); setOpen(false) }} className="block w-full border-t px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-50">{isEn ? 'Clear vehicle' : '清除车辆'}</button>}
    </div>}
  </div>
}
