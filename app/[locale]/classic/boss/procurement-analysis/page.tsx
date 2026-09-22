'use client'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { downloadXlsx } from '@/lib/xlsx-export'
import {
  defaultRange, SearchSelectDropdown, searchProductOptions, searchSupplierOptions, type SearchOption,
} from '@/components/boss/analytics-shared'

const PURPLE = '#875A7B'

// 20260915：客户 3 条采购分析需求（按供应商查进货/按产品看销售+库存趋势/按产品查进货）。
// 交互范式照抄 sales-analysis（工具条+视图切换），不复用 reports/purchasing 的透视表 UI，
// 只借它证明过可行的"配置驱动聚合"思路——具体聚合走新写的两个路由。
type ViewType = 'purchase' | 'trend'
type GroupBy = 'product' | 'supplier'
type Granularity = 'week' | 'month'

interface PurchaseRow {
  key: string
  name: string
  poCount: number
  orderedQty: number
  receivedQty: number
  amountExTax: number
  taxAmount: number
  amountIncTax: number
  avgUnitCost: number
  // 20260922：只在 groupBy=product 时后端才返回这三列（按供应商维度"毛利"没有意义）
  salesQty?: number
  salesAmount?: number
  grossProfit?: number
}
interface PurchasePayload {
  summary: { amountExTax: number; taxAmount: number; amountIncTax: number; orderedQty: number; salesQty?: number; salesAmount?: number; grossProfit?: number }
  groupBy: GroupBy
  rows: PurchaseRow[]
}

interface StockTrendPoint { bucketStart: string; bucketEnd: string; onHand: number; soldQty: number }
interface StockTrendSeries { productId: string; productName: string; points: StockTrendPoint[] }
interface StockTrendPayload { granularity: Granularity; series: StockTrendSeries[] }

export default function ProcurementAnalysisPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [view, setView] = useState<ViewType>('purchase')
  const [groupBy, setGroupBy] = useState<GroupBy>('product')
  const [range, setRange] = useState(() => defaultRange(30))
  const [granularity, setGranularity] = useState<Granularity>('week')
  const [supplierFilter, setSupplierFilter] = useState<SearchOption[]>([])
  const [productFilter, setProductFilter] = useState<SearchOption[]>([])
  const [groupByOpen, setGroupByOpen] = useState(false)
  const groupByRef = useRef<HTMLDivElement>(null)

  const [data, setData] = useState<PurchasePayload | null>(null)
  const [trendData, setTrendData] = useState<StockTrendPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (groupByRef.current && !groupByRef.current.contains(e.target as Node)) setGroupByOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    setLoading(true)
    setError(null)
    // 20260922 code review：groupBy 切换时不清空 data，旧 groupBy 的行(含/不含销售三列)
    // 留在屏幕上、也留在 exportPurchaseExcel 可导出的状态，直到新请求落地——这段窗口内
    // 点"下载 Excel"，表头按新 groupBy 算、数据却是旧 groupBy 查出来的，对不上。
    setData(null)

    if (view === 'trend') {
      if (productFilter.length === 0) { setTrendData(null); setLoading(false); return }
      const qs = new URLSearchParams({ from: range.from, to: range.to, granularity, productIds: productFilter.map((p) => p.id).join(',') })
      apiGet<StockTrendPayload>(`/api/analytics/procurement-analysis/stock-trend?${qs.toString()}`)
        .then(setTrendData)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
      return
    }

    const qs = new URLSearchParams({ from: range.from, to: range.to, groupBy })
    if (supplierFilter[0]) qs.set('supplierId', supplierFilter[0].id)
    if (productFilter.length) qs.set('productIds', productFilter.map((p) => p.id).join(','))
    apiGet<PurchasePayload>(`/api/analytics/procurement-analysis/pivot?${qs.toString()}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [view, groupBy, range, granularity, supplierFilter, productFilter])

  function exportPurchaseExcel() {
    if (!data) return
    const withSales = groupBy === 'product'
    const headers = [
      ...(isEn ? ['Name', 'PO Count', 'Ordered Qty', 'Received Qty', 'Untaxed', 'Tax', 'Total (inc. tax)', 'Avg Unit Cost']
               : ['名称', 'PO数', '订购数量', '已收数量', '未税金额', '税额', '含税金额', '平均单价']),
      ...(withSales ? (isEn ? ['Sales Qty', 'Sales Amount', 'Gross Profit'] : ['销售数量', '销售额', '毛利']) : []),
    ]
    const rows = data.rows.map((r) => [
      r.name, r.poCount, r.orderedQty, r.receivedQty, r.amountExTax, r.taxAmount, r.amountIncTax, r.avgUnitCost,
      ...(withSales ? [r.salesQty ?? 0, r.salesAmount ?? 0, r.grossProfit ?? 0] : []),
    ])
    downloadXlsx(`procurement-vs-sales-${groupBy}-${range.from}_${range.to}`, headers, rows)
  }

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{isEn ? 'Purchase vs Sales Analysis' : '进销对比分析'}</h1>
          <p className="text-sm text-gray-400 mt-0.5">{isEn ? 'Purchases by supplier/product, sales & margin, + stock trend' : '按供应商/产品查进货情况，按产品对比销售与毛利 + 库存趋势'}</p>
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3 shadow-sm">

        {/* View toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          {(isEn
            ? [['purchase', '☰', 'Purchases'], ['trend', '📈', 'Stock Trend']] as const
            : [['purchase', '☰', '进货情况'], ['trend', '📈', '库存趋势']] as const
          ).map(([v, icon, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="px-3 py-1.5 text-sm transition-colors"
              style={view === v ? { background: PURPLE, color: 'white' } : { background: 'white', color: '#6b7280' }}
            >
              {icon} <span className="ml-1">{label}</span>
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-gray-200" />

        {/* 时间段 */}
        <div className="flex items-center gap-1.5 text-sm">
          <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
          <span className="text-gray-400">→</span>
          <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="border border-gray-200 rounded-lg px-2 py-1" />
        </div>

        {view === 'purchase' && (
          <>
            <div className="h-5 w-px bg-gray-200" />
            {/* 维度：按产品/按供应商 */}
            <div className="relative" ref={groupByRef}>
              <button
                onClick={() => setGroupByOpen((o) => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white"
              >
                <span>{isEn ? 'Group by' : '按维度'}: {groupBy === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Supplier' : '供应商')}</span>
                <span className="text-gray-400">▾</span>
              </button>
              {groupByOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[160px] py-1">
                  {(['product', 'supplier'] as GroupBy[]).map((g) => (
                    <button
                      key={g}
                      onClick={() => { setGroupBy(g); setGroupByOpen(false) }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                    >
                      {groupBy === g && <span style={{ color: PURPLE }}>✓</span>}
                      {groupBy !== g && <span className="w-4" />}
                      {g === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Supplier' : '供应商')}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="h-5 w-px bg-gray-200" />
            {/* 需求5：某一家供货商 —— 单选 */}
            <SearchSelectDropdown
              label={isEn ? 'Supplier' : '供应商'}
              selected={supplierFilter}
              onChange={setSupplierFilter}
              fetchOptions={searchSupplierOptions}
              multiple={false}
              isEn={isEn}
            />
          </>
        )}

        {/* 需求7(购买视图)/需求6(趋势视图,必选) ：产品多选 */}
        <SearchSelectDropdown
          label={isEn ? 'Products' : '产品'}
          selected={productFilter}
          onChange={setProductFilter}
          fetchOptions={searchProductOptions}
          isEn={isEn}
        />

        {view === 'trend' && (
          <div className="flex items-center gap-1">
            {(['week', 'month'] as Granularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className="px-3 py-1.5 rounded-lg text-sm transition-colors border"
                style={granularity === g ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { background: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}
              >
                {g === 'week' ? (isEn ? 'Week' : '按周') : (isEn ? 'Month' : '按月')}
              </button>
            ))}
          </div>
        )}

        {view === 'purchase' && (
          <button
            type="button"
            onClick={exportPurchaseExcel}
            disabled={!data}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white disabled:opacity-40"
          >
            ⬇ {isEn ? 'Download Excel' : '下载 Excel'}
          </button>
        )}
      </div>

      {/* ── Main Content ───────────────────────────────────────────────────── */}
      {view === 'purchase' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {error && <div className="text-center text-red-500 py-10 text-sm">{error}</div>}
          {!error && loading && !data && <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>}
          {!error && data && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">{groupBy === 'product' ? (isEn ? 'Product' : '产品') : (isEn ? 'Supplier' : '供应商')}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">PO</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Ordered Qty' : '订购数量'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Received Qty' : '已收数量'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Avg Cost' : '均价'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Untaxed' : '未税'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Tax' : '税额'}</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Total (inc. tax)' : '含税总额'}</th>
                  {groupBy === 'product' && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Sales Qty' : '销售数量'}</th>
                      <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Sales Amount' : '销售额'}</th>
                      <th className="text-right px-4 py-3 font-semibold text-gray-600">{isEn ? 'Gross Profit' : '毛利'}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={groupBy === 'product' ? 11 : 8} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.key} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-800">{r.name}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{r.poCount}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{r.orderedQty}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{r.receivedQty}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.avgUnitCost)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.amountExTax)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.taxAmount)}</td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-gray-900 font-medium">{eur(r.amountIncTax)}</td>
                    {groupBy === 'product' && (
                      <>
                        <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{r.salesQty ?? 0}</td>
                        <td className="text-right px-4 py-2.5 tabular-nums text-gray-700">{eur(r.salesAmount ?? 0)}</td>
                        <td className={`text-right px-4 py-2.5 tabular-nums font-medium ${(r.grossProfit ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{eur(r.grossProfit ?? 0)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                    <td className="px-4 py-3 text-gray-700">{isEn ? 'Total' : '总计'}</td>
                    <td className="text-right px-4 py-3" />
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{data.summary.orderedQty}</td>
                    <td className="text-right px-4 py-3" />
                    <td className="text-right px-4 py-3" />
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.amountExTax)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.taxAmount)}</td>
                    <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.amountIncTax)}</td>
                    {groupBy === 'product' && (
                      <>
                        <td className="text-right px-4 py-3 tabular-nums text-gray-900">{data.summary.salesQty ?? 0}</td>
                        <td className="text-right px-4 py-3 tabular-nums text-gray-900">{eur(data.summary.salesAmount ?? 0)}</td>
                        <td className={`text-right px-4 py-3 tabular-nums ${(data.summary.grossProfit ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{eur(data.summary.grossProfit ?? 0)}</td>
                      </>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      )}

      {view === 'trend' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {productFilter.length === 0 && (
            <div className="text-center text-gray-400 py-16 text-sm">
              {isEn ? 'Pick at least one product above to see its on-hand / sold-qty trend' : '请先在上面选至少一个产品，才能看 on-hand / 出货量趋势'}
            </div>
          )}
          {error && <div className="text-center text-red-500 py-10 text-sm">{error}</div>}
          {!error && loading && !trendData && productFilter.length > 0 && (
            <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
          )}
          {!error && trendData && (
            <div className="p-4 space-y-6">
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                {isEn
                  ? 'Forecast here means "actual sold qty in that period" (not a predictive algorithm) — a simple trend hint, confirmed with the customer 20260915.'
                  : '"forecast" 这里是"该分桶的历史实际出货量"（不是预测算法），只是趋势参考，口径已跟客户确认(20260915)'}
              </div>
              {trendData.series.map((s) => (
                <div key={s.productId}>
                  <div className="text-sm font-semibold text-gray-700 mb-2">{s.productName}</div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-3 py-2 font-semibold text-gray-600">{granularity === 'week' ? (isEn ? 'Week' : '周') : (isEn ? 'Month' : '月')}</th>
                        <th className="text-right px-3 py-2 font-semibold text-gray-600">{isEn ? 'On Hand (end of period)' : 'On Hand(期末)'}</th>
                        <th className="text-right px-3 py-2 font-semibold text-gray-600">{isEn ? 'Sold Qty (forecast proxy)' : '出货量(forecast近似)'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.points.map((p) => (
                        <tr key={p.bucketStart} className="border-b border-gray-50">
                          <td className="px-3 py-1.5 text-gray-700">{p.bucketStart}</td>
                          <td className="text-right px-3 py-1.5 tabular-nums text-gray-800">{p.onHand}</td>
                          <td className="text-right px-3 py-1.5 tabular-nums text-gray-800">{p.soldQty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
