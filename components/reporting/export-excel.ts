import * as XLSX from 'xlsx'
import type { ReportingState } from './ReportingContext'
import type { DimensionSpec, MeasureMeta } from '@/lib/reports/types'
import { rowFieldAlias } from '@/lib/reports/drilldown'
import { bucketLabel } from '@/lib/reports/date-label'

/**
 * ⛔ 维度取值必须经 `rowFieldAlias` 取、经 `bucketLabel` 显示。
 * 日期维度在结果集里的列名带粒度后缀（`order_date` + month → `order_date_month`，
 * 见 lib/reports/sql-builder.ts），直接读 `row[d.field]` 恒为 undefined。
 *
 * 20260920 修屏幕上那张表（PivotTable.tsx）时，这个文件被漏掉了一轮 ——
 * 结果是**屏幕对、下载错**，比两边都错更容易骗人：用户核对过页面之后才导出。
 * 交叉表里它的后果是所有时间桶塌成一个空列且后一个月覆盖前一个月；
 * 扁平表里是日期那一列整列空白。
 */
function dimValue(dim: DimensionSpec, row: Record<string, unknown>): unknown {
  return row[rowFieldAlias(dim)]
}

function dimText(dim: DimensionSpec, value: unknown, isEn: boolean): string {
  if (dim.interval) return bucketLabel(value, dim.interval, isEn)
  return String(value ?? '')
}

const REPORT_LABELS_ZH: Record<string, string> = { sales: '销售分析', purchasing: '采购分析', logistics: '物流分析' }
const REPORT_LABELS_EN: Record<string, string> = { sales: 'Sales Analysis', purchasing: 'Purchasing Analysis', logistics: 'Logistics Analysis' }

export function exportToExcel(state: ReportingState, isEn = false) {
  const { rows, totals, rowDimensions, colDimensions, activeMeasures, measureDefs, dimensionDefs, reportType } = state

  const measuresMap = new Map<string, MeasureMeta>()
  measureDefs.forEach(m => measuresMap.set(m.field, m))

  const getDimLabel = (field: string) =>
    dimensionDefs.find(d => d.field === field)?.[isEn ? 'label' : 'labelZh'] ?? field

  const hasCols = colDimensions.length > 0
  const activeMetas = activeMeasures.map(f => measuresMap.get(f)).filter(Boolean) as MeasureMeta[]

  if (!hasCols) {
    return exportFlatTable(rows, rowDimensions, activeMetas, totals, getDimLabel, reportType, isEn)
  }
  return exportCrossTable(state, activeMetas, getDimLabel, reportType, isEn)
}

function exportFlatTable(
  rows: Record<string, unknown>[],
  rowDimensions: { field: string }[],
  activeMetas: MeasureMeta[],
  totals: Record<string, number>,
  getDimLabel: (f: string) => string,
  reportType: string,
  isEn: boolean,
) {
  const headers = [
    ...rowDimensions.map(d => getDimLabel(d.field)),
    ...activeMetas.map(m => isEn ? m.label : m.labelZh),
  ]

  const data = rows.map(row => [
    ...rowDimensions.map(d => dimText(d, dimValue(d, row), isEn)),
    ...activeMetas.map(m => Number(row[m.field] ?? 0)),
  ])

  const totalRow = [
    isEn ? 'Total' : '合计',
    ...Array(rowDimensions.length - 1).fill(''),
    ...activeMetas.map(m => totals[m.field] ?? 0),
  ]

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data, totalRow])
  applyColumnWidths(ws, headers.length, rowDimensions.length)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, isEn ? 'Report' : '报表')

  const reportLabels = isEn ? REPORT_LABELS_EN : REPORT_LABELS_ZH
  const filename = `${reportLabels[reportType] ?? reportType}_${formatDate()}.xlsx`
  XLSX.writeFile(wb, filename)
}

function exportCrossTable(
  state: ReportingState,
  activeMetas: MeasureMeta[],
  getDimLabel: (f: string) => string,
  reportType: string,
  isEn: boolean,
) {
  const { rows, totals, rowDimensions, colDimensions, activeMeasures } = state

  const colKeySet = new Set<string>()
  const colLabelMap = new Map<string, Record<string, unknown>>()
  const rowMap = new Map<string, Map<string, Record<string, number>>>()
  const rowLabelMap = new Map<string, Record<string, unknown>>()

  for (const row of rows) {
    const colKey = colDimensions.map(d => String(dimValue(d, row) ?? '')).join('|')
    const rowKey = rowDimensions.map(d => String(dimValue(d, row) ?? '')).join('|')

    if (!colLabelMap.has(colKey)) {
      colKeySet.add(colKey)
      const labels: Record<string, unknown> = {}
      colDimensions.forEach(d => { labels[d.field] = dimValue(d, row) })
      colLabelMap.set(colKey, labels)
    }
    if (!rowMap.has(rowKey)) {
      rowMap.set(rowKey, new Map())
      const labels: Record<string, unknown> = {}
      rowDimensions.forEach(d => { labels[d.field] = dimValue(d, row) })
      rowLabelMap.set(rowKey, labels)
    }

    const measures: Record<string, number> = {}
    activeMeasures.forEach(m => { measures[m] = Number(row[m] ?? 0) })
    rowMap.get(rowKey)!.set(colKey, measures)
  }

  // 列序与屏幕上那张表一致（PivotTable 同样排过）：不排的话，第一行恰好缺某个月，
  // 整张表的列序就跟着数据到达顺序乱掉，导出的 xlsx 与页面对不上
  const colKeys = Array.from(colKeySet).sort((a, b) => a.localeCompare(b))
  const multi = activeMetas.length > 1

  const colLabel = (ck: string) => {
    const labels = colLabelMap.get(ck)
    if (!labels) return ck
    return colDimensions.map(d => dimText(d, labels[d.field], isEn)).join(' / ')
  }

  const dimHeaders = rowDimensions.map(d => getDimLabel(d.field))

  let headers: (string | number)[]
  if (multi) {
    headers = [
      ...dimHeaders,
      ...colKeys.flatMap(ck => activeMetas.map(m => `${colLabel(ck)} - ${isEn ? m.label : m.labelZh}`)),
      ...activeMetas.map(m => `${isEn ? 'Total' : '合计'} - ${isEn ? m.label : m.labelZh}`),
    ]
  } else {
    headers = [
      ...dimHeaders,
      ...colKeys.map(ck => colLabel(ck)),
      isEn ? 'Total' : '合计',
    ]
  }

  const dataRows: (string | number)[][] = []
  for (const [rk, colMap] of rowMap) {
    const labels = rowLabelMap.get(rk)!
    const dimVals = rowDimensions.map(d => dimText(d, labels[d.field], isEn))

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
    isEn ? 'Total' : '合计',
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
  XLSX.utils.book_append_sheet(wb, ws, isEn ? 'Report' : '报表')

  const reportLabels = isEn ? REPORT_LABELS_EN : REPORT_LABELS_ZH
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
