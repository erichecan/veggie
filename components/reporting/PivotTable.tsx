'use client'

import { useMemo, Fragment, type Dispatch } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  Table, TableHeader, TableBody, TableFooter,
  TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { useReporting } from './ReportingContext'
import type { MeasureMeta, DimensionMeta, DimensionSpec } from '@/lib/reports/types'
import { drillCandidates, rowFieldAlias, rowKeyOf } from '@/lib/reports/drilldown'
import type { ReportingState, ReportingAction } from './ReportingContext'
import { ChevronDown } from 'lucide-react'
import { eur } from '@/lib/format-money'

export function formatValue(value: unknown, format: MeasureMeta['format']): string {
  if (value == null) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)

  switch (format) {
    case 'currency':
      return eur(num)
    case 'decimal':
      return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)
    case 'integer':
      return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(num)
    case 'percentage':
      return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(num)}%`
    case 'weight':
      return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)} kg`
    default:
      return String(num)
  }
}

export function PivotTable() {
  const { state, dispatch, drillDown } = useReporting()
  const { rows, totals, rowDimensions, colDimensions, activeMeasures, measureDefs, dimensionDefs, orderBy } = state
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const measuresMap = useMemo(() => {
    const map = new Map<string, MeasureMeta>()
    measureDefs.forEach(m => map.set(m.field, m))
    return map
  }, [measureDefs])

  const activeMetas = useMemo(
    () => activeMeasures.map(f => measuresMap.get(f)).filter(Boolean) as MeasureMeta[],
    [activeMeasures, measuresMap],
  )

  const getDimLabel = (field: string) =>
    dimensionDefs.find(d => d.field === field)?.[isEn ? 'label' : 'labelZh'] ?? field

  const hasCols = colDimensions.length > 0

  const pivotData = useMemo(() => {
    if (!hasCols) return null

    const colKeySet = new Set<string>()
    const colLabelMap = new Map<string, Record<string, unknown>>()
    const rowMap = new Map<string, Map<string, Record<string, number>>>()
    const rowLabelMap = new Map<string, Record<string, unknown>>()

    for (const row of rows) {
      const colKey = colDimensions.map(d => String(row[d.field] ?? '')).join('|')
      const rowKey = rowDimensions.map(d => String(row[d.field] ?? '')).join('|')

      if (!colLabelMap.has(colKey)) {
        colKeySet.add(colKey)
        const labels: Record<string, unknown> = {}
        colDimensions.forEach(d => { labels[d.field] = row[d.field] })
        colLabelMap.set(colKey, labels)
      }
      if (!rowMap.has(rowKey)) {
        rowMap.set(rowKey, new Map())
        const labels: Record<string, unknown> = {}
        rowDimensions.forEach(d => { labels[d.field] = row[d.field] })
        rowLabelMap.set(rowKey, labels)
      }

      const measures: Record<string, number> = {}
      activeMeasures.forEach(m => { measures[m] = Number(row[m] ?? 0) })
      rowMap.get(rowKey)!.set(colKey, measures)
    }

    const colKeys = Array.from(colKeySet)

    const rowTotals = new Map<string, Record<string, number>>()
    rowMap.forEach((colMap, rk) => {
      const sums: Record<string, number> = {}
      activeMeasures.forEach(m => { sums[m] = 0 })
      colMap.forEach(measures => {
        activeMeasures.forEach(m => { sums[m] += measures[m] ?? 0 })
      })
      rowTotals.set(rk, sums)
    })

    const colTotals = new Map<string, Record<string, number>>()
    colKeys.forEach(ck => {
      const sums: Record<string, number> = {}
      activeMeasures.forEach(m => { sums[m] = 0 })
      colTotals.set(ck, sums)
    })
    rowMap.forEach(colMap => {
      colMap.forEach((measures, ck) => {
        const sums = colTotals.get(ck)!
        activeMeasures.forEach(m => { sums[m] += measures[m] ?? 0 })
      })
    })

    return { colKeys, colLabelMap, rowKeys: Array.from(rowMap.keys()), rowMap, rowLabelMap, rowTotals, colTotals }
  }, [rows, rowDimensions, colDimensions, activeMeasures, hasCols])

  const handleSort = (field: string) => {
    const cur = orderBy[0]
    if (cur?.field === field) {
      dispatch({
        type: 'SET_ORDER_BY',
        orderBy: cur.direction === 'asc' ? [{ field, direction: 'desc' }] : [],
      })
    } else {
      dispatch({ type: 'SET_ORDER_BY', orderBy: [{ field, direction: 'asc' }] })
    }
  }

  const sortIcon = (field: string) => {
    const cur = orderBy[0]
    if (cur?.field !== field) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />
    return cur.direction === 'asc'
      ? <ArrowUp className="h-3 w-3 ml-1" />
      : <ArrowDown className="h-3 w-3 ml-1" />
  }

  if (rows.length === 0 && !state.loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        {state.metadataLoaded
          ? (isEn ? 'No data, please adjust the filters' : '暂无数据，请调整筛选条件')
          : (isEn ? 'Loading...' : '加载中...')}
      </div>
    )
  }

  if (!hasCols || !pivotData) return <FlatTable {...{ rows, rowDimensions, activeMetas, totals, getDimLabel, handleSort, sortIcon, isEn, dimensionDefs, drill: state.drill, drillDown, dispatch }} />

  return <CrossTab pivotData={pivotData} {...{ rowDimensions, colDimensions, activeMetas, totals, getDimLabel, isEn }} />
}

function FlatTable({
  rows, rowDimensions, activeMetas, totals, getDimLabel, handleSort, sortIcon, isEn,
  dimensionDefs, drill, drillDown, dispatch,
}: {
  rows: Record<string, unknown>[]
  rowDimensions: DimensionSpec[]
  activeMetas: MeasureMeta[]
  totals: Record<string, number>
  getDimLabel: (f: string) => string
  handleSort: (f: string) => void
  sortIcon: (f: string) => React.ReactNode
  isEn: boolean
  dimensionDefs: DimensionMeta[]
  drill: ReportingState['drill']
  drillDown: (rowKey: string, row: Record<string, unknown>, by: DimensionSpec) => Promise<void>
  dispatch: Dispatch<ReportingAction>
}) {
  // 下钻目标：排掉已经在行上用过的维度（再展开一次只会得到一模一样的一行）
  const candidates = drillCandidates(dimensionDefs, rowDimensions)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {rowDimensions.map(d => (
            <TableHead key={d.field} className="cursor-pointer select-none" onClick={() => handleSort(d.field)}>
              <div className="flex items-center">{getDimLabel(d.field)}{sortIcon(d.field)}</div>
            </TableHead>
          ))}
          {activeMetas.map(m => (
            <TableHead key={m.field} className="text-right cursor-pointer select-none" onClick={() => handleSort(m.field)}>
              <div className="flex items-center justify-end">{isEn ? m.label : m.labelZh}{sortIcon(m.field)}</div>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, idx) => {
          const rk = rowKeyOf(rowDimensions, row)
          const d = drill[rk]
          // 值为空的行锁不住（`= ''` 筛不到 NULL），宁可不给点也不要给一张假的空表
          const canDrill = candidates.length > 0 && rowDimensions.every(dim => {
            const v = row[rowFieldAlias(dim)]
            return v !== null && v !== undefined && v !== ''
          })
          return (
          <Fragment key={rk || idx}>
          <TableRow>
            {rowDimensions.map((dim, i) => (
              <TableCell key={dim.field} className="font-medium">
                <div className="flex items-center gap-1">
                  {i === 0 && canDrill && (
                    d
                      ? (
                        <button type="button" className="text-muted-foreground hover:text-foreground"
                          title={isEn ? 'Collapse' : '收起'}
                          onClick={() => dispatch({ type: 'DRILL_COLLAPSE', rowKey: rk })}>
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      )
                      : (
                        <select
                          className="h-5 w-5 shrink-0 cursor-pointer appearance-none rounded border bg-transparent text-transparent"
                          title={isEn ? 'Expand by…' : '按维度展开…'}
                          value=""
                          onChange={e => {
                            const f = e.target.value
                            const by = candidates.find(c => c.field === f)
                            if (by) drillDown(rk, row, { field: by.field })
                            e.target.value = ''
                          }}>
                          <option value="">▸</option>
                          {candidates.map(c => (
                            <option key={c.field} value={c.field}>{isEn ? c.label : c.labelZh}</option>
                          ))}
                        </select>
                      )
                  )}
                  <span>{String(row[rowFieldAlias(dim)] ?? '-')}</span>
                </div>
              </TableCell>
            ))}
            {activeMetas.map(m => (
              <TableCell key={m.field} className="text-right tabular-nums">{formatValue(row[m.field], m.format)}</TableCell>
            ))}
          </TableRow>
          {d?.loading && (
            <TableRow><TableCell colSpan={rowDimensions.length + activeMetas.length} className="text-xs text-muted-foreground pl-8">
              {isEn ? 'Loading…' : '展开中…'}
            </TableCell></TableRow>
          )}
          {d?.error && (
            <TableRow><TableCell colSpan={rowDimensions.length + activeMetas.length} className="text-xs text-red-600 pl-8">{d.error}</TableCell></TableRow>
          )}
          {d && !d.loading && !d.error && d.rows.length === 0 && (
            <TableRow><TableCell colSpan={rowDimensions.length + activeMetas.length} className="text-xs text-muted-foreground pl-8">
              {isEn ? 'No detail rows' : '这一行下面没有明细'}
            </TableCell></TableRow>
          )}
          {d?.rows.map((child, ci) => (
            <TableRow key={`${rk}|c${ci}`} className="bg-muted/20">
              <TableCell colSpan={rowDimensions.length} className="pl-8 text-muted-foreground">
                <span className="mr-1 opacity-50">└</span>
                {String(child[rowFieldAlias(d.by)] ?? '-')}
                <span className="ml-2 text-[10px] opacity-60">{getDimLabel(d.by.field)}</span>
              </TableCell>
              {activeMetas.map(m => (
                <TableCell key={m.field} className="text-right tabular-nums text-muted-foreground">
                  {formatValue(child[m.field], m.format)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          </Fragment>
        )})}
      </TableBody>
      {Object.keys(totals).length > 0 && (
        <TableFooter>
          <TableRow>
            <TableCell colSpan={rowDimensions.length} className="font-bold">{isEn ? 'Total' : '合计'}</TableCell>
            {activeMetas.map(m => (
              <TableCell key={m.field} className="text-right font-bold tabular-nums">
                {formatValue(totals[m.field], m.format)}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      )}
    </Table>
  )
}

function CrossTab({
  pivotData, rowDimensions, colDimensions, activeMetas, totals, getDimLabel, isEn,
}: {
  pivotData: {
    colKeys: string[]
    colLabelMap: Map<string, Record<string, unknown>>
    rowKeys: string[]
    rowMap: Map<string, Map<string, Record<string, number>>>
    rowLabelMap: Map<string, Record<string, unknown>>
    rowTotals: Map<string, Record<string, number>>
    colTotals: Map<string, Record<string, number>>
  }
  rowDimensions: { field: string }[]
  colDimensions: { field: string }[]
  activeMetas: MeasureMeta[]
  totals: Record<string, number>
  getDimLabel: (f: string) => string
  isEn: boolean
}) {
  const { colKeys, colLabelMap, rowKeys, rowMap, rowLabelMap, rowTotals, colTotals } = pivotData
  const multi = activeMetas.length > 1

  const colLabel = (ck: string) => {
    const labels = colLabelMap.get(ck)
    if (!labels) return ck
    return colDimensions.map(d => String(labels[d.field] ?? '')).join(' / ')
  }

  return (
    <Table>
      <TableHeader>
        {multi ? (
          <>
            <TableRow>
              <TableHead rowSpan={2} colSpan={rowDimensions.length} className="border-r align-bottom">
                {rowDimensions.map(d => getDimLabel(d.field)).join(' / ')}
              </TableHead>
              {colKeys.map(ck => (
                <TableHead key={ck} colSpan={activeMetas.length} className="text-center border-x">{colLabel(ck)}</TableHead>
              ))}
              <TableHead colSpan={activeMetas.length} className="text-center border-l bg-muted/30">{isEn ? 'Total' : '合计'}</TableHead>
            </TableRow>
            <TableRow>
              {colKeys.flatMap(ck =>
                activeMetas.map(m => (
                  <TableHead key={`${ck}|${m.field}`} className="text-right text-xs border-x">{isEn ? m.label : m.labelZh}</TableHead>
                )),
              )}
              {activeMetas.map(m => (
                <TableHead key={`t|${m.field}`} className="text-right text-xs border-l bg-muted/30">{isEn ? m.label : m.labelZh}</TableHead>
              ))}
            </TableRow>
          </>
        ) : (
          <TableRow>
            {rowDimensions.map(d => (
              <TableHead key={d.field} className="border-r">{getDimLabel(d.field)}</TableHead>
            ))}
            {colKeys.map(ck => (
              <TableHead key={ck} className="text-right">{colLabel(ck)}</TableHead>
            ))}
            <TableHead className="text-right bg-muted/30">{isEn ? 'Total' : '合计'}</TableHead>
          </TableRow>
        )}
      </TableHeader>
      <TableBody>
        {rowKeys.map(rk => {
          const labels = rowLabelMap.get(rk)!
          const colMap = rowMap.get(rk)!
          const rTotals = rowTotals.get(rk)!
          return (
            <TableRow key={rk}>
              {rowDimensions.map(d => (
                <TableCell key={d.field} className="font-medium border-r">{String(labels[d.field] ?? '-')}</TableCell>
              ))}
              {multi
                ? colKeys.flatMap(ck => {
                    const cell = colMap.get(ck)
                    return activeMetas.map(m => (
                      <TableCell key={`${ck}|${m.field}`} className="text-right tabular-nums">
                        {cell ? formatValue(cell[m.field], m.format) : '-'}
                      </TableCell>
                    ))
                  })
                : colKeys.map(ck => {
                    const cell = colMap.get(ck)
                    return (
                      <TableCell key={ck} className="text-right tabular-nums">
                        {cell ? formatValue(cell[activeMetas[0].field], activeMetas[0].format) : '-'}
                      </TableCell>
                    )
                  })}
              {multi
                ? activeMetas.map(m => (
                    <TableCell key={`t|${m.field}`} className="text-right tabular-nums font-medium bg-muted/30">
                      {formatValue(rTotals[m.field], m.format)}
                    </TableCell>
                  ))
                : (
                    <TableCell className="text-right tabular-nums font-medium bg-muted/30">
                      {formatValue(rTotals[activeMetas[0].field], activeMetas[0].format)}
                    </TableCell>
                  )}
            </TableRow>
          )
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={rowDimensions.length} className="font-bold border-r">{isEn ? 'Total' : '合计'}</TableCell>
          {multi
            ? colKeys.flatMap(ck => {
                const ct = colTotals.get(ck)!
                return activeMetas.map(m => (
                  <TableCell key={`${ck}|${m.field}`} className="text-right font-bold tabular-nums">
                    {formatValue(ct[m.field], m.format)}
                  </TableCell>
                ))
              })
            : colKeys.map(ck => {
                const ct = colTotals.get(ck)!
                return (
                  <TableCell key={ck} className="text-right font-bold tabular-nums">
                    {formatValue(ct[activeMetas[0].field], activeMetas[0].format)}
                  </TableCell>
                )
              })}
          {multi
            ? activeMetas.map(m => (
                <TableCell key={`gt|${m.field}`} className="text-right font-bold tabular-nums bg-muted/30">
                  {formatValue(totals[m.field], m.format)}
                </TableCell>
              ))
            : (
                <TableCell className="text-right font-bold tabular-nums bg-muted/30">
                  {formatValue(totals[activeMetas[0].field], activeMetas[0].format)}
                </TableCell>
              )}
        </TableRow>
      </TableFooter>
    </Table>
  )
}
