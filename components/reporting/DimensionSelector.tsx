'use client'

import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Plus, X, GripVertical } from 'lucide-react'
import { useReporting } from './ReportingContext'
import { DateIntervalPicker } from './DateIntervalPicker'
import type { DimensionMeta, DimensionSpec } from '@/lib/reports/types'

interface DimensionSelectorProps {
  axis: 'row' | 'col'
  label: string
}

export function DimensionSelector({ axis, label }: DimensionSelectorProps) {
  const { state, dispatch } = useReporting()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const dims = axis === 'row' ? state.rowDimensions : state.colDimensions
  const allDefs = state.dimensionDefs

  const usedFields = new Set([
    ...state.rowDimensions.map(d => d.field),
    ...state.colDimensions.map(d => d.field),
  ])
  const availableDims = allDefs.filter(d => !usedFields.has(d.field))

  const addDim = (meta: DimensionMeta) => {
    const spec: DimensionSpec = { field: meta.field }
    if ((meta.type === 'date' || meta.type === 'datetime') && meta.dateIntervals?.length) {
      spec.interval = 'month'
    }
    dispatch({
      type: axis === 'row' ? 'ADD_ROW_DIMENSION' : 'ADD_COL_DIMENSION',
      dim: spec,
    })
  }

  const removeDim = (field: string) => {
    dispatch({
      type: axis === 'row' ? 'REMOVE_ROW_DIMENSION' : 'REMOVE_COL_DIMENSION',
      field,
    })
  }

  const updateInterval = (field: string, interval: string) => {
    const current = axis === 'row' ? state.rowDimensions : state.colDimensions
    const updated = current.map(d =>
      d.field === field ? { ...d, interval: interval as DimensionSpec['interval'] } : d
    )
    dispatch({
      type: axis === 'row' ? 'SET_ROW_DIMENSIONS' : 'SET_COL_DIMENSIONS',
      dims: updated,
    })
  }

  const getDimLabel = (field: string) => {
    const meta = allDefs.find(d => d.field === field)
    return (isEn ? meta?.label : meta?.labelZh) ?? field
  }

  const getDimMeta = (field: string) => {
    return allDefs.find(d => d.field === field)
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted-foreground whitespace-nowrap">{label}:</span>
      {dims.map(dim => {
        const meta = getDimMeta(dim.field)
        const hasInterval = meta && (meta.type === 'date' || meta.type === 'datetime')
        return (
          <Badge key={dim.field} variant="secondary" className="gap-1 pr-1 text-xs">
            <GripVertical className="h-3 w-3 text-muted-foreground cursor-grab" />
            <span>{getDimLabel(dim.field)}</span>
            {hasInterval && dim.interval && (
              <DateIntervalPicker
                value={dim.interval}
                intervals={meta.dateIntervals!}
                onChange={(v) => updateInterval(dim.field, v)}
              />
            )}
            <button
              onClick={() => removeDim(dim.field)}
              className="ml-0.5 rounded-full hover:bg-muted p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-1.5 h-6 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          disabled={availableDims.length === 0}
        >
          <Plus className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
          <DimensionMenuItems items={availableDims} onSelect={addDim} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DimensionMenuItems({
  items,
  onSelect,
}: {
  items: DimensionMeta[]
  onSelect: (d: DimensionMeta) => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const dimLabel = (d: DimensionMeta) => (isEn ? d.label : d.labelZh)

  const groups = {
    string: items.filter(d => d.type === 'string' || d.type === 'enum'),
    date: items.filter(d => d.type === 'date' || d.type === 'datetime'),
    number: items.filter(d => d.type === 'number'),
  }

  return (
    <>
      {groups.date.length > 0 && (
        <>
          {groups.date.map(d => (
            <DropdownMenuItem key={d.field} onClick={() => onSelect(d)}>
              📅 {dimLabel(d)}
            </DropdownMenuItem>
          ))}
          {(groups.string.length > 0 || groups.number.length > 0) && <DropdownMenuSeparator />}
        </>
      )}
      {groups.string.map(d => (
        <DropdownMenuItem key={d.field} onClick={() => onSelect(d)}>
          {dimLabel(d)}
        </DropdownMenuItem>
      ))}
      {groups.number.length > 0 && (
        <>
          <DropdownMenuSeparator />
          {groups.number.map(d => (
            <DropdownMenuItem key={d.field} onClick={() => onSelect(d)}>
              # {dimLabel(d)}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  )
}
