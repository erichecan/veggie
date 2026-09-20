'use client'
import { useEffect, useState } from 'react'
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
// 20260915（二次调整）：list 视图（按时间/产品/客户切换维度的汇总表）再砍掉——
// 跟"按周"视图功能重叠，只保留 week（按周，支持产品/客户筛选）和 detail（明细）。
type ViewType = 'week' | 'detail'

interface DetailRow {
  orderDate: string
  customerName: string
  productName: string
  /** 20260920 客户要求：产品后面要能看到单位（见 lib/sale-uom.ts displayUomName 口径） */
  uomName: string
  unitPrice: number
  qty: number
  subtotal: number
}
interface DetailPayload { rows: DetailRow[]; truncated: boolean }

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SalesAnalysisPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [view, setView] = useState<ViewType>('week')
  const [range, setRange] = useState(() => defaultRange(30))
  const [productFilter, setProductFilter] = useState<SearchOption[]>([])
  const [customerFilter, setCustomerFilter] = useState<SearchOption[]>([])

  const [detailData, setDetailData] = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const productIds = productFilter.map((p) => p.id).join(',')
  const customerIds = customerFilter.map((c) => c.id).join(',')

  useEffect(() => {
    if (view !== 'detail') return
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ from: range.from, to: range.to })
    if (customerIds) qs.set('customerIds', customerIds)
    if (productIds) qs.set('productIds', productIds)
    apiGet<DetailPayload>(`/api/analytics/sales-analysis/detail?${qs.toString()}`)
      .then(setDetailData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [view, range, productIds, customerIds])

  function exportDetailCsv() {
    if (!detailData) return
    const headers = isEn
      ? ['Date', 'Customer', 'Product', 'Unit', 'Unit Price', 'Qty', 'Amount']
      : ['日期', '客户', '产品', '单位', '单价', '数量', '金额']
    const rows = detailData.rows.map((r) => [r.orderDate, r.customerName, r.productName, r.uomName, eur(r.unitPrice), String(r.qty), eur(r.subtotal)])
    downloadCsv(`sales-detail-${range.from}_${range.to}`, headers, rows)
  }

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
            ? [['week', '📅', 'Drilldown'], ['detail', '📋', 'Detail']] as const
            : [['week', '📅', '钻取'], ['detail', '📋', '明细']] as const
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

        <div className="h-5 w-px bg-gray-200" />

        {view === 'detail' && (
          <>
            {/* 时间段 */}
            <div className="flex items-center gap-1.5 text-sm">
              <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
              <span className="text-gray-400">→</span>
              <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
            </div>
            <div className="h-5 w-px bg-gray-200" />
          </>
        )}

        {/* 多选筛选：产品/客户 —— week / detail 通用 */}
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

        {view === 'detail' && (
          <button
            type="button"
            onClick={exportDetailCsv}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
          >
            ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
          </button>
        )}
      </div>

      {/* ── Main Content ───────────────────────────────────────────────────── */}
      {view === 'week' && <WeeklyDrilldown isEn={isEn} productIds={productIds} customerIds={customerIds} />}

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
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">{isEn ? 'Unit' : '单位'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Unit Price' : '单价'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Amount' : '金额'}</th>
                  </tr>
                </thead>
                <tbody>
                  {detailData.rows.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-16 text-gray-400">{isEn ? 'No data — pick a time range and, optionally, a few customers/products' : '暂无数据，选一个时间段，也可以再选几个客户/产品缩小范围'}</td></tr>
                  )}
                  {detailData.rows.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700">{r.orderDate}</td>
                      <td className="px-4 py-2 text-gray-700">{r.customerName}</td>
                      <td className="px-4 py-2 text-gray-700">{r.productName}</td>
                      <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{r.uomName}</td>
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
