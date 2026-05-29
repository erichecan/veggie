'use client'

import { ArrowLeftRight, Download, X } from 'lucide-react'
import { useReporting } from './ReportingContext'
import { MeasureSelector } from './MeasureSelector'
import { GroupBySelector } from './GroupBySelector'
import { FilterPanel } from './FilterPanel'
import { exportToExcel } from './export-excel'
import type { DateInterval } from '@/lib/reports/types'

const INTERVAL_LABELS: Record<DateInterval, string> = {
  day: '日',
  week: '周',
  month: '月',
  quarter: '季',
  year: '年',
}

const FILTER_OP_LABELS: Record<string, string> = {
  '=': '=',
  '!=': '≠',
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
  like: '~',
  in: '∈',
  not_in: '∉',
  between: '↔',
}

export function ReportingToolbar() {
  const { state, dispatch } = useReporting()

  const getDimLabel = (field: string) =>
    state.dimensionDefs.find(d => d.field === field)?.labelZh ?? field

  const getFieldLabel = (field: string) => {
    const dim = state.dimensionDefs.find(d => d.field === field)
    if (dim) return dim.labelZh
    const meas = state.measureDefs.find(m => m.field === field)
    if (meas) return meas.labelZh
    return field
  }

  const formatFilterValue = (v: string | number | string[] | [string, string], op: string) => {
    if (op === 'between' && Array.isArray(v)) return `${v[0]}~${v[1]}`
    if (Array.isArray(v)) return (v as string[]).join(',')
    return String(v)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* LEFT: action buttons */}
        <MeasureSelector />
        <button
          onClick={() => dispatch({ type: 'FLIP_AXES' })}
          className="inline-flex items-center justify-center rounded-md border border-input bg-background h-8 w-8 text-sm ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="行列互换"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <button
          onClick={() => exportToExcel(state)}
          disabled={state.rows.length === 0}
          className="inline-flex items-center justify-center rounded-md border border-input bg-background h-8 w-8 text-sm ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          title="导出 Excel"
        >
          <Download className="h-4 w-4" />
        </button>

        {/* spacer */}
        <div className="flex-1" />

        {/* RIGHT: facet chips + controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Row dimension chips — blue */}
          {state.rowDimensions.map(d => (
            <span
              key={`row-${d.field}`}
              className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 px-2 py-0.5 text-xs font-medium"
            >
              {getDimLabel(d.field)}
              {d.interval && `: ${INTERVAL_LABELS[d.interval]}`}
              <button
                onClick={() => dispatch({ type: 'REMOVE_ROW_DIMENSION', field: d.field })}
                className="ml-0.5 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          {/* Column dimension chips — violet */}
          {state.colDimensions.map(d => (
            <span
              key={`col-${d.field}`}
              className="inline-flex items-center gap-1 rounded-md bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300 px-2 py-0.5 text-xs font-medium"
            >
              {getDimLabel(d.field)}
              {d.interval && `: ${INTERVAL_LABELS[d.interval]}`}
              <button
                onClick={() => dispatch({ type: 'REMOVE_COL_DIMENSION', field: d.field })}
                className="ml-0.5 rounded-full hover:bg-violet-200 dark:hover:bg-violet-800 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          {/* Filter chips — amber */}
          {state.filters.map((f, idx) => (
            <span
              key={`filter-${idx}`}
              className="inline-flex items-center gap-1 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 text-xs font-medium"
            >
              {getFieldLabel(f.field)} {FILTER_OP_LABELS[f.operator] ?? f.operator} {formatFilterValue(f.value, f.operator)}
              <button
                onClick={() => dispatch({ type: 'REMOVE_FILTER', index: idx })}
                className="ml-0.5 rounded-full hover:bg-amber-200 dark:hover:bg-amber-800 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <GroupBySelector />
          <FilterPanel />
        </div>
      </div>

      {state.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </div>
      )}
    </div>
  )
}
