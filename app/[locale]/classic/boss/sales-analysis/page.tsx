'use client'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import { defaultRange, SearchSelectDropdown, searchProductOptions, searchCustomerOptions, type SearchOption } from '@/components/boss/analytics-shared'
import WeeklyDrilldown from './WeeklyDrilldown'

const PURPLE = '#875A7B'

// ─── View types ───────────────────────────────────────────────────────────────
// 20260915：客户提7条分析需求，把 pie/bar 图表视图砍掉（margin/discountAmount 此前
// 一直是写死返回 0 的假数据，客户端聚合口径也跟"按周"视图的服务端真实口径不一致），
// 只保留表格类视图；list 视图改接服务端 /api/analytics/margin（真实 qty/price/
// untaxed/vat/total/margin），新增 detail 明细清单视图（需求4）。
type ViewType = 'list' | 'week' | 'detail'

// ─── 维度（对应需求1/2/3：按时间/按产品/按客户） ────────────────────────────────
type DimensionKey = 'time' | 'product' | 'customer'
type Granularity = 'week' | 'month' | 'quarter' | 'year'

const GRANULARITY_OPTIONS: { key: Granularity; labelZh: string; labelEn: string }[] = [
  { key: 'week', labelZh: '周', labelEn: 'Week' },
  { key: 'month', labelZh: '月', labelEn: 'Month' },
  { key: 'quarter', labelZh: '季', labelEn: 'Quarter' },
  { key: 'year', labelZh: '年', labelEn: 'Year' },
]

// ─── /api/analytics/margin 非透视分支的行结构（见 app/api/analytics/margin/route.ts） ──
interface MarginRow {
  key: string
  name: string
  lineCount: number
  qty: number
  revenueExTax: number
  totalIncTax: number
  vat: number
  avgPrice: number
  cost: number
  grossProfit: number
  marginPct: number
}
interface MarginPayload {
  summary: { revenueExTax: number; totalIncTax: number; grossProfit: number; vat: number; marginPct: number }
  rows: MarginRow[]
}

interface DetailRow {
  orderDate: string
  customerName: string
  productName: string
  unitPrice: number
  qty: number
  subtotal: number
}
interface DetailPayload { rows: DetailRow[]; truncated: boolean }

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SalesAnalysisPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [view, setView] = useState<ViewType>('list')
  const [dimension, setDimension] = useState<DimensionKey>('time')
  const [granularity, setGranularity] = useState<Granularity>('week')
  const [range, setRange] = useState(() => defaultRange(30))
  const [productFilter, setProductFilter] = useState<SearchOption[]>([])
  const [customerFilter, setCustomerFilter] = useState<SearchOption[]>([])
  const [dimOpen, setDimOpen] = useState(false)
  const dimRef = useRef<HTMLDivElement>(null)

  const [data, setData] = useState<MarginPayload | null>(null)
  const [detailData, setDetailData] = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dimRef.current && !dimRef.current.contains(e.target as Node)) setDimOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (view === 'week') return
    setLoading(true)
    setError(null)
    const productIds = productFilter.map((p) => p.id).join(',')
    const customerIds = customerFilter.map((c) => c.id).join(',')

    if (view === 'detail') {
      const qs = new URLSearchParams({ from: range.from, to: range.to })
      if (customerIds) qs.set('customerIds', customerIds)
      if (productIds) qs.set('productIds', productIds)
      apiGet<DetailPayload>(`/api/analytics/sales-analysis/detail?${qs.toString()}`)
        .then(setDetailData)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
      return
    }

    const groupBy = dimension === 'time' ? granularity : dimension
    const qs = new URLSearchParams({ from: range.from, to: range.to, groupBy })
    if (productIds) qs.set('productId', productIds)
    if (customerIds) qs.set('customerId', customerIds)
    apiGet<MarginPayload>(`/api/analytics/margin?${qs.toString()}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [view, dimension, granularity, range, productFilter, customerFilter])

  // /api/analytics/margin 非透视分支按毛利降序排（给毛利分析页用），按时间维度看时
  // 必须重排成时间升序，否则"2026-W27, W28, W26…"这种乱序没法当时间序列看
  // （WeeklyDrilldown 同样做法，见该文件 rowsAsc 注释）。
  function orderedRows(): MarginRow[] {
    if (!data) return []
    return dimension === 'time' ? [...data.rows].sort((a, b) => a.key.localeCompare(b.key)) : data.rows
  }

  function exportListCsv() {
    if (!data) return
    const headers = isEn
      ? ['Name', 'Qty', 'Avg Price', 'Untaxed', 'VAT', 'Total (inc. tax)', 'Margin', 'Margin %']
      : ['名称', '数量', '均价', '未税', '税额', '含税总额', '毛利', '毛利率']
    const rows = orderedRows().map((r) => [r.name, String(r.qty), eur(r.avgPrice), eur(r.revenueExTax), eur(r.vat), eur(r.totalIncTax), eur(r.grossProfit), `${r.marginPct}%`])
    downloadCsv(`sales-analysis-${dimension === 'time' ? granularity : dimension}-${range.from}_${range.to}`, headers, rows)
  }

  function exportDetailCsv() {
    if (!detailData) return
    const headers = isEn
      ? ['Date', 'Customer', 'Product', 'Unit Price', 'Qty', 'Amount']
      : ['日期', '客户', '产品', '单价', '数量', '金额']
    const rows = detailData.rows.map((r) => [r.orderDate, r.customerName, r.productName, eur(r.unitPrice), String(r.qty), eur(r.subtotal)])
    downloadCsv(`sales-detail-${range.from}_${range.to}`, headers, rows)
  }

  const dimensionLabel = (() => {
    if (dimension === 'time') {
      const g = GRANULARITY_OPTIONS.find((g) => g.key === granularity)
      return isEn ? `Time (${g?.labelEn})` : `时间(按${g?.labelZh})`
    }
    return dimension === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Customer' : '客户')
  })()

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sales Analysis</h1>
          <p className="text-sm text-gray-400 mt-0.5">{isEn ? 'Odoo-style sales analysis report' : 'Odoo 风格销售分析报表'}</p>
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3 shadow-sm">

        {/* View toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          {(isEn
            ? [['list', '☰', 'List'], ['week', '📅', 'Weekly'], ['detail', '📋', 'Detail']] as const
            : [['list', '☰', '列表'], ['week', '📅', '按周'], ['detail', '📋', '明细']] as const
          ).map(([v, icon, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              title={label}
              className="px-3 py-1.5 text-sm transition-colors"
              style={view === v ? { background: PURPLE, color: 'white' } : { background: 'white', color: '#6b7280' }}
            >
              {icon} <span className="ml-1">{label}</span>
            </button>
          ))}
        </div>

        {view !== 'week' && (
          <>
            <div className="h-5 w-px bg-gray-200" />

            {/* 时间段 */}
            <div className="flex items-center gap-1.5 text-sm">
              <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
              <span className="text-gray-400">→</span>
              <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
            </div>

            {view === 'list' && (
              <>
                <div className="h-5 w-px bg-gray-200" />
                {/* 维度：时间/产品/客户 —— 对应需求1/2/3 */}
                <div className="relative" ref={dimRef}>
                  <button
                    onClick={() => setDimOpen((o) => !o)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white"
                  >
                    <span>{isEn ? 'Group by' : '按维度'}: {dimensionLabel}</span>
                    <span className="text-gray-400">▾</span>
                  </button>
                  {dimOpen && (
                    <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[200px] py-1">
                      {(['time', 'product', 'customer'] as DimensionKey[]).map((d) => (
                        <div key={d}>
                          <button
                            onClick={() => { setDimension(d); if (d !== 'time') setDimOpen(false) }}
                            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                          >
                            {dimension === d && <span style={{ color: PURPLE }}>✓</span>}
                            {dimension !== d && <span className="w-4" />}
                            {d === 'time' ? (isEn ? 'Time' : '时间') : d === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Customer' : '客户')}
                          </button>
                          {d === 'time' && dimension === 'time' && (
                            <div className="pl-8 pb-1 flex flex-wrap gap-1">
                              {GRANULARITY_OPTIONS.map((g) => (
                                <button
                                  key={g.key}
                                  onClick={() => { setGranularity(g.key); setDimOpen(false) }}
                                  className="px-2 py-0.5 rounded text-xs border"
                                  style={granularity === g.key ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { borderColor: '#e5e7eb', color: '#6b7280' }}
                                >
                                  {isEn ? g.labelEn : g.labelZh}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="h-5 w-px bg-gray-200" />

            {/* 多选筛选：产品/客户 —— 需求1/2/3/4 通用 */}
            <SearchSelectDropdown
              label={isEn ? 'Products' : '产品'}
              selected={productFilter}
              onChange={setProductFilter}
              fetchOptions={searchProductOptions}
              isEn={isEn}
            />
            <SearchSelectDropdown
              label={isEn ? 'Customers' : '客户'}
              selected={customerFilter}
              onChange={setCustomerFilter}
              fetchOptions={searchCustomerOptions}
              isEn={isEn}
            />

            <button
              type="button"
              onClick={view === 'detail' ? exportDetailCsv : exportListCsv}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
            >
              ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
            </button>
          </>
        )}
      </div>

      {/* ── Main Content ───────────────────────────────────────────────────── */}
      {view === 'week' && <WeeklyDrilldown isEn={isEn} />}

      {view === 'list' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {error && <div className="text-center text-red-500 py-10 text-sm">{error}</div>}
          {!error && loading && !data && <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>}
          {!error && data && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">{dimension === 'time' ? (isEn ? 'Period' : '时间') : dimension === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Customer' : '客户')}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Avg Price' : '均价'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Untaxed' : '未税'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'VAT' : '税额'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Total (inc. tax)' : '含税总额'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Margin %' : '毛利率'}</th>
                </tr>
              </thead>
              <tbody>
                {orderedRows().length === 0 && (
                  <tr><td colSpan={8} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {orderedRows().map((r) => (
                  <tr key={r.key} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-800">{r.name}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{r.qty}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.avgPrice)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.revenueExTax)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.vat)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-900 font-medium">{eur(r.totalIncTax)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.grossProfit)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-500">{r.marginPct}%</td>
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                    <td className="px-4 py-3 text-gray-700">{isEn ? 'Total' : '总计'}</td>
                    <td className="text-right px-4 py-3" />
                    <td className="text-right px-4 py-3" />
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.revenueExTax)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.vat)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.totalIncTax)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.grossProfit)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-600">{data.summary.marginPct}%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      )}

      {view === 'detail' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {error && <div className="text-center text-red-500 py-10 text-sm">{error}</div>}
          {!error && loading && !detailData && <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>}
          {!error && detailData && (
            <>
              {detailData.truncated && (
                <div className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-b border-amber-100">
                  {isEn ? 'Too many rows — showing the first 2000, narrow the filters for a complete view.' : '结果过多，只显示前 2000 行，请缩小筛选范围以看到完整结果。'}
                </div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">{isEn ? 'Date' : '日期'}</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">{isEn ? 'Customer' : '客户'}</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">{isEn ? 'Product' : '产品'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Unit Price' : '单价'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Amount' : '金额'}</th>
                  </tr>
                </thead>
                <tbody>
                  {detailData.rows.length === 0 && (
                    <tr><td colSpan={6} className="text-center py-16 text-gray-400">{isEn ? 'No data — pick a time range and, optionally, a few customers/products' : '暂无数据，选一个时间段，也可以再选几个客户/产品缩小范围'}</td></tr>
                  )}
                  {detailData.rows.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700">{r.orderDate}</td>
                      <td className="px-4 py-2 text-gray-700">{r.customerName}</td>
                      <td className="px-4 py-2 text-gray-700">{r.productName}</td>
                      <td className="text-right px-4 py-2 tabular-nums text-gray-700">{eur(r.unitPrice)}</td>
                      <td className="text-right px-4 py-2 tabular-nums text-gray-700">{r.qty}</td>
                      <td className="text-right px-4 py-2 tabular-nums text-gray-900">{eur(r.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
