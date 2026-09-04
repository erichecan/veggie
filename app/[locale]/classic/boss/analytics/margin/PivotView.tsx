'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import { DIMENSION_OPTIONS } from '@/lib/analytics/pivot'
import type { DateRange } from '@/components/boss/analytics-shared'

type Measure = 'revenueExTax' | 'grossProfit' | 'marginPct' | 'qty'

interface PivotMeasures {
  revenueExTax: number
  cost: number
  grossProfit: number
  marginPct: number
  qty: number
}

interface PivotHeader { key: string; name: string; subtotal: PivotMeasures }
interface PivotCell extends PivotMeasures { rowKey: string; colKey: string }

interface PivotPayload {
  summary: { revenueExTax: number; grossProfit: number; marginPct: number; costCoverageRate: number }
  rows: PivotHeader[]
  cols: PivotHeader[]
  cells: PivotCell[]
  grandTotal: PivotMeasures
}

interface LookupItem { id: string; name: string }

const MEASURE_TABS_ZH: Array<{ key: Measure; label: string }> = [
  { key: 'revenueExTax', label: '销售额' },
  { key: 'grossProfit', label: '毛利' },
  { key: 'marginPct', label: '毛利率' },
  { key: 'qty', label: '数量' },
]
const MEASURE_TABS_EN: Array<{ key: Measure; label: string }> = [
  { key: 'revenueExTax', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'marginPct', label: 'Margin %' },
  { key: 'qty', label: 'Qty' },
]

// DIMENSION_OPTIONS(lib/analytics/pivot.ts)的 label 是中文，本页是这个常量唯一的消费点，
// 就地维护一份英文对照，不动共享 lib（该文件还有 PivotTooManyColumnsError 等其他消费方）。
const DIMENSION_LABEL_EN: Record<string, string> = {
  product: 'Product', category: 'Category', customer: 'Customer',
  salesUser: 'Salesperson', day: 'Day', week: 'Week', month: 'Month',
}
function dimLabel(key: string, isEn: boolean): string {
  if (isEn) return DIMENSION_LABEL_EN[key] ?? key
  return DIMENSION_OPTIONS.find((o) => o.key === key)?.label ?? key
}

function formatMeasure(measure: Measure, value: number): string {
  if (measure === 'marginPct') return `${value.toFixed(1)}%`
  if (measure === 'qty') return value.toLocaleString('en-IE', { maximumFractionDigits: 3 })
  return eur(value)
}

function csvMeasure(measure: Measure, value: number): string {
  if (measure === 'marginPct') return value.toFixed(1)
  if (measure === 'qty') return String(value)
  return value.toFixed(2)
}

export default function PivotView({ range, isEn }: { range: DateRange; isEn: boolean }) {
  const MEASURE_TABS = isEn ? MEASURE_TABS_EN : MEASURE_TABS_ZH
  const [rowBy, setRowBy] = useState('customer')
  const [colBy, setColBy] = useState('month')
  const [measure, setMeasure] = useState<Measure>('revenueExTax')
  const [categoryId, setCategoryId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [salesUserId, setSalesUserId] = useState('')
  const [categories, setCategories] = useState<LookupItem[]>([])
  const [customers, setCustomers] = useState<LookupItem[]>([])
  const [salesUsers, setSalesUsers] = useState<LookupItem[]>([])
  const [data, setData] = useState<PivotPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiGet<Array<{ id: string; name: string; nameZh?: string | null }>>('/api/product-categories')
      .then((rows) => setCategories(rows.map((c) => ({ id: c.id, name: c.nameZh || c.name }))))
      .catch((e) => toast.error(e.message))
    apiGet<Array<{ id: string; name: string }>>('/api/customers?slim=1')
      .then((rows) => setCustomers(rows.map((c) => ({ id: c.id, name: c.name }))))
      .catch((e) => toast.error(e.message))
    apiGet<Array<{ id: string; name: string }>>('/api/users?role=SALES')
      .then((rows) => setSalesUsers(rows.map((u) => ({ id: u.id, name: u.name }))))
      .catch((e) => toast.error(e.message))
  }, [])

  const load = useCallback(() => {
    setData(null)
    setError(null)
    const params = new URLSearchParams({ from: range.from, to: range.to, groupBy: rowBy, colBy })
    if (categoryId) params.set('categoryId', categoryId)
    if (customerId) params.set('customerId', customerId)
    if (salesUserId) params.set('salesUserId', salesUserId)
    apiGet<PivotPayload>(`/api/analytics/margin?${params.toString()}`)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [range, rowBy, colBy, categoryId, customerId, salesUserId])
  useEffect(() => { load() }, [load])

  const cellMap = useMemo(() => {
    const m = new Map<string, PivotCell>()
    data?.cells.forEach((c) => m.set(`${c.rowKey}|${c.colKey}`, c))
    return m
  }, [data])

  const filteredRows = (data?.rows ?? []).filter((r) =>
    search.trim() === '' || r.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  function handleRowByChange(next: string) {
    const prevRowBy = rowBy
    setRowBy(next)
    if (next === colBy) setColBy(prevRowBy)
  }
  function handleColByChange(next: string) {
    const prevColBy = colBy
    setColBy(next)
    if (next === rowBy) setRowBy(prevColBy)
  }

  function exportCsv() {
    if (!data) return
    const rowLabel = dimLabel(rowBy, isEn) || (isEn ? 'Row' : '行')
    const headers = [rowLabel, ...data.cols.map((c) => c.name), isEn ? 'Subtotal' : '小计']
    const rows = data.rows.map((r) => [
      r.name,
      ...data.cols.map((c) => {
        const cell = cellMap.get(`${r.key}|${c.key}`)
        return cell ? csvMeasure(measure, cell[measure]) : ''
      }),
      csvMeasure(measure, r.subtotal[measure]),
    ])
    rows.push([
      isEn ? 'Grand Total' : '总计',
      ...data.cols.map((c) => csvMeasure(measure, c.subtotal[measure])),
      csvMeasure(measure, data.grandTotal[measure]),
    ])
    downloadCsv(`margin-pivot-${range.from}_${range.to}`, headers, rows)
  }

  const coverage = (data?.summary.costCoverageRate ?? 0) * 100

  return (
    <div className="space-y-3">
      {data && coverage < 70 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-2.5">
          {isEn
            ? `⚠ Actual lot-cost coverage is only ${coverage.toFixed(0)}% — the rest is estimated at standard cost (weighted-average on receipt).`
            : `⚠ 实际批次成本覆盖率仅 ${coverage.toFixed(0)}%，其余按标准成本（收货加权平均）估算。`}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-gray-500">{isEn ? 'Row' : '行'}</label>
        <select className="border rounded px-2 py-1" value={rowBy} onChange={(e) => handleRowByChange(e.target.value)}>
          {DIMENSION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{dimLabel(o.key, isEn)}</option>)}
        </select>
        <label className="text-gray-500">{isEn ? 'Column' : '列'}</label>
        <select className="border rounded px-2 py-1" value={colBy} onChange={(e) => handleColByChange(e.target.value)}>
          {DIMENSION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{dimLabel(o.key, isEn)}</option>)}
        </select>
        <label className="text-gray-500 ml-2">{isEn ? 'Measure' : '度量'}</label>
        <div className="flex border rounded overflow-hidden">
          {MEASURE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setMeasure(t.key)}
              className={`px-3 py-1 ${measure === t.key ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select className="border rounded px-2 py-1 ml-2" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">{isEn ? 'All Categories' : '全部分类'}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">{isEn ? 'All Customers' : '全部客户'}</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={salesUserId} onChange={(e) => setSalesUserId(e.target.value)}>
          <option value="">{isEn ? 'All Salespeople' : '全部业务员'}</option>
          {salesUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input
          className="border rounded px-3 py-1 w-48 ml-2"
          placeholder={isEn ? 'Search row name…' : '搜索行名…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="border rounded px-3 py-1 text-white ml-auto disabled:opacity-40"
          style={{ backgroundColor: '#875A7B' }}
          disabled={!data}
          onClick={exportCsv}
        >
          {isEn ? 'Export CSV' : '导出 CSV'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-4 py-2.5">{error}</div>
      )}

      {!data && !error ? (
        <div className="text-center text-gray-400 py-24 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : data ? (
        <div className="border rounded overflow-auto max-h-[70vh]">
          <table className="text-sm border-collapse">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left font-medium sticky left-0 bg-gray-50 z-20 border-r whitespace-nowrap">
                  {dimLabel(rowBy, isEn)} \ {dimLabel(colBy, isEn)}
                </th>
                {data.cols.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-right font-medium whitespace-nowrap">{c.name}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap border-l">{isEn ? 'Subtotal' : '小计'}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr key={r.key} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-1.5 sticky left-0 bg-white z-10 border-r font-medium whitespace-nowrap">{r.name}</td>
                  {data.cols.map((c) => {
                    const cell = cellMap.get(`${r.key}|${c.key}`)
                    const negative = cell && (measure === 'grossProfit' || measure === 'marginPct') && cell[measure] < 0
                    return (
                      <td key={c.key} className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${negative ? 'text-red-600' : ''}`}>
                        {cell ? formatMeasure(measure, cell[measure]) : '—'}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap border-l font-medium">
                    {formatMeasure(measure, r.subtotal[measure])}
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr><td colSpan={data.cols.length + 2} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No matching data' : '没有匹配的数据'}</td></tr>
              )}
            </tbody>
            {filteredRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2">
                <tr>
                  <td className="px-3 py-1.5 sticky left-0 bg-gray-50 border-r font-medium whitespace-nowrap">{isEn ? 'Grand Total' : '总计'}</td>
                  {data.cols.map((c) => (
                    <td key={c.key} className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
                      {formatMeasure(measure, c.subtotal[measure])}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap border-l">
                    {formatMeasure(measure, data.grandTotal[measure])}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      ) : null}
    </div>
  )
}
