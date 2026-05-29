'use client'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BarChart3 } from 'lucide-react'
import { useReporting } from './ReportingContext'

export function MeasureSelector() {
  const { state, dispatch } = useReporting()

  const currencyMeasures = state.measureDefs.filter(m => m.format === 'currency')
  const qtyMeasures = state.measureDefs.filter(m => m.format === 'decimal' || m.format === 'weight')
  const countMeasures = state.measureDefs.filter(m => m.format === 'integer')
  const otherMeasures = state.measureDefs.filter(m => m.format === 'percentage')

  const activeCount = state.activeMeasures.length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 h-8 text-sm font-medium ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <BarChart3 className="h-4 w-4" />
        度量 ({activeCount})
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 max-h-80 overflow-y-auto">
        {currencyMeasures.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">金额</DropdownMenuLabel>
            {currencyMeasures.map(m => (
              <DropdownMenuCheckboxItem
                key={m.field}
                checked={state.activeMeasures.includes(m.field)}
                onCheckedChange={() => dispatch({ type: 'TOGGLE_MEASURE', measure: m.field })}
              >
                {m.labelZh}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        )}
        {qtyMeasures.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">数量</DropdownMenuLabel>
              {qtyMeasures.map(m => (
                <DropdownMenuCheckboxItem
                  key={m.field}
                  checked={state.activeMeasures.includes(m.field)}
                  onCheckedChange={() => dispatch({ type: 'TOGGLE_MEASURE', measure: m.field })}
                >
                  {m.labelZh}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {countMeasures.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">计数</DropdownMenuLabel>
              {countMeasures.map(m => (
                <DropdownMenuCheckboxItem
                  key={m.field}
                  checked={state.activeMeasures.includes(m.field)}
                  onCheckedChange={() => dispatch({ type: 'TOGGLE_MEASURE', measure: m.field })}
                >
                  {m.labelZh}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {otherMeasures.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {otherMeasures.map(m => (
                <DropdownMenuCheckboxItem
                  key={m.field}
                  checked={state.activeMeasures.includes(m.field)}
                  onCheckedChange={() => dispatch({ type: 'TOGGLE_MEASURE', measure: m.field })}
                >
                  {m.labelZh}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
