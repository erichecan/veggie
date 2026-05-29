'use client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, Layers } from 'lucide-react'
import { useReporting } from './ReportingContext'
import type { DateInterval, DimensionSpec } from '@/lib/reports/types'

const INTERVAL_LABELS: Record<DateInterval, string> = {
  year: '年',
  quarter: '季度',
  month: '月',
  week: '周',
  day: '日',
}

export function GroupBySelector() {
  const { state, dispatch } = useReporting()

  const handleToggle = (
    axis: 'row' | 'col',
    field: string,
    interval?: DateInterval,
  ) => {
    const dims = axis === 'row' ? state.rowDimensions : state.colDimensions
    const existing = dims.find(d => d.field === field)

    let next: DimensionSpec[]
    if (existing) {
      if (interval && existing.interval !== interval) {
        next = dims.map(d => (d.field === field ? { field, interval } : d))
      } else {
        next = dims.filter(d => d.field !== field)
      }
    } else {
      const spec: DimensionSpec = interval ? { field, interval } : { field }
      next = [...dims, spec]
    }

    dispatch({
      type: axis === 'row' ? 'SET_ROW_DIMENSIONS' : 'SET_COL_DIMENSIONS',
      dims: next,
    })
  }

  const renderDimItems = (axis: 'row' | 'col') => {
    const dims = axis === 'row' ? state.rowDimensions : state.colDimensions
    const nonDateDims = state.dimensionDefs.filter(
      d => !d.dateIntervals || d.dateIntervals.length === 0,
    )
    const dateDims = state.dimensionDefs.filter(
      d => d.dateIntervals && d.dateIntervals.length > 0,
    )

    return (
      <>
        {nonDateDims.map(d => {
          const isActive = dims.some(dim => dim.field === d.field)
          return (
            <DropdownMenuItem
              key={d.field}
              onClick={() => handleToggle(axis, d.field)}
            >
              <span className="w-4 shrink-0">
                {isActive && <Check className="h-3.5 w-3.5" />}
              </span>
              {d.labelZh}
            </DropdownMenuItem>
          )
        })}
        {dateDims.length > 0 && nonDateDims.length > 0 && (
          <DropdownMenuSeparator />
        )}
        {dateDims.map(d => {
          const activeDim = dims.find(dim => dim.field === d.field)
          return (
            <DropdownMenuSub key={d.field}>
              <DropdownMenuSubTrigger>
                <span className="w-4 shrink-0">
                  {activeDim && <Check className="h-3.5 w-3.5" />}
                </span>
                {d.labelZh}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {d.dateIntervals!.map(iv => {
                  const isActive =
                    activeDim?.interval === iv
                  return (
                    <DropdownMenuItem
                      key={iv}
                      onClick={() => handleToggle(axis, d.field, iv)}
                    >
                      <span className="w-4 shrink-0">
                        {isActive && <Check className="h-3.5 w-3.5" />}
                      </span>
                      {INTERVAL_LABELS[iv]}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
      </>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Layers className="h-4 w-4" />
        分组
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            行分组
          </DropdownMenuLabel>
          {renderDimItems('row')}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            列分组
          </DropdownMenuLabel>
          {renderDimItems('col')}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
