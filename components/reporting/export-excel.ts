import * as XLSX from 'xlsx'
import type { ReportingState } from './ReportingContext'
import type { MeasureMeta } from '@/lib/reports/types'

export function exportToExcel(state: ReportingState) {
  const { rows, totals, rowDimensions, colDimensions, activeMeasures, measureDefs, dimensionDefs, reportType } = state

  const measuresMap = new Map<string, MeasureMeta>()
  measureDefs.forEach(m => measuresMap.set(m.field, m))

  const getDimLabel = (field: string) =>
    dimensionDefs.find(d => d.field === field)?.labelZh ?? field

  const hasCols = colDimensions.length > 0
  const activeMetas = activeMeasures.map(f => measuresMap.get(f)).filter(Boolean) as MeasureMeta[]

  if (!hasCols) {
    return exportFlatTable(rows, rowDimensions, activeMetas, totals, getDimLabel, reportType)
  }
  return exportCrossTable(state, activeMetas, getDimLabel, reportType)
}

function exportFlatTable(
  rows: Record<string, unknown>[],
  rowDimensions: { field: string }[],
  activeMetas: MeasureMeta[],
  totals: Record<string, number>,
  getDimLabel: (f: string) => string,
  reportType: string,
) {
  const headers = [
    ...rowDimensions.map(d => getDimLabel(d.field)),
    ...activeMetas.map(m => m.labelZh),
  ]

  const data = rows.map(row => [
    ...rowDimensions.map(d => row[d.field] ?? ''),
    ...activeMetas.map(m => Number(row[m.field] ?? 0)),
  ])

  const totalRow = [
    '合计',
    ...Array(rowDimensions.length - 1).fill(''),
    ...activeMetas.map(m => totals[m.field] ?? 0),
  ]

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data, totalRow])
  applyColumnWidths(ws, headers.length, rowDimensions.length)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '报表')

  const reportLabels: Record<string, string> = { sales: '销售分析', purchasing: '采购分析', logistics: '物流分析' }
  const filename = `${reportLabels[reportType] ?? reportType}_${formatDate()}.xlsx`
  XLSX.writeFile(wb, filename)
}

function exportCrossTable(
  state: ReportingState,
  activeMetas: MeasureMeta[],
  getDimLabel: (f: string) => string,
  reportType: string,
) {
  const { rows, totals, rowDimensions, colDimensions, activeMeasures } = state

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
  const multi = activeMetas.length > 1

  const colLabel = (ck: string) => {
    const labels = colLabelMap.get(ck)
    if (!labels) return ck
    return colDimensions.map(d => String(labels[d.field] ?? '')).join(' / ')
  }

  const dimHeaders = rowDimensions.map(d => getDimLabel(d.field))

  let headers: (string | number)[]
  if (multi) {
    headers = [
      ...dimHeaders,
      ...colKeys.flatMap(ck => activeMetas.map(m => `${colLabel(ck)} - ${m.labelZh}`)),
      ...activeMetas.map(m => `合计 - ${m.labelZh}`),
    ]
  } else {
    headers = [
      ...dimHeaders,
      ...colKeys.map(ck => colLabel(ck)),
      '合计',
    ]
  }

  const dataRows: (string | number)[][] = []
  for (const [rk, colMap] of rowMap) {
    const labels = rowLabelMap.get(rk)!
    const dimVals = rowDimensions.map(d => String(labels[d.field] ?? ''))

    const rowTotals: Record<string, number> = {}
    activeMeasures.forEach(m => { rowTotals[m] = 0 })
    colMap.forEach(measures => {
      activeMeasures.forEach(m => { rowTotals[m] += measures[m] ?? 0 })
    })

    if (multi) {
      dataRows.push([
        ...dimVals,
        ...colKeys.flatMap(ck => {
          const cell = colMap.get(ck)
          return activeMetas.map(m => cell ? cell[m.field] ?? 0 : 0)
        }),
        ...activeMetas.map(m => rowTotals[m.field] ?? 0),
      ])
    } else {
      dataRows.push([
        ...dimVals,
        ...colKeys.map(ck => {
          const cell = colMap.get(ck)
          return cell ? cell[activeMetas[0].field] ?? 0 : 0
        }),
        rowTotals[activeMetas[0].field] ?? 0,
      ])
    }
  }

  const totalRow: (string | number)[] = [
    '合计',
    ...Array(rowDimensions.length - 1).fill(''),
  ]

  const colTotals = new Map<string, Record<string, number>>()
  colKeys.forEach(ck => {
    const sums: Record<string, number> = {}
    activeMeasures.forEach(m => { sums[m] = 0 })
    colTotals.set(ck, sums)
  })
  rowMap.forEach(colMap => {
    colMap.forEach((measures, ck) => {
      const sums = colTotals.get(ck)
      if (sums) activeMeasures.forEach(m => { sums[m] += measures[m] ?? 0 })
    })
  })

  if (multi) {
    colKeys.forEach(ck => {
      const ct = colTotals.get(ck)!
      activeMetas.forEach(m => { totalRow.push(ct[m.field] ?? 0) })
    })
    activeMetas.forEach(m => { totalRow.push(totals[m.field] ?? 0) })
  } else {
    colKeys.forEach(ck => {
      const ct = colTotals.get(ck)!
      totalRow.push(ct[activeMetas[0].field] ?? 0)
    })
    totalRow.push(totals[activeMetas[0].field] ?? 0)
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows, totalRow])
  applyColumnWidths(ws, headers.length, rowDimensions.length)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '报表')

  const reportLabels: Record<string, string> = { sales: '销售分析', purchasing: '采购分析', logistics: '物流分析' }
  const filename = `${reportLabels[reportType] ?? reportType}_${formatDate()}.xlsx`
  XLSX.writeFile(wb, filename)
}

function applyColumnWidths(ws: XLSX.WorkSheet, totalCols: number, dimCols: number) {
  const widths: XLSX.ColInfo[] = []
  for (let i = 0; i < totalCols; i++) {
    widths.push({ wch: i < dimCols ? 18 : 14 })
  }
  ws['!cols'] = widths
}

function formatDate() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
