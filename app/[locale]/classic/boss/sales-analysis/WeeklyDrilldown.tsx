'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'

const PURPLE = '#875A7B'
const WEEKS_PAGE_SIZE = 8
/** 选中某天「按产品明细」时，日行与右侧新表共用的高亮色 */
const HIGHLIGHT_BG = '#FEF3C7'
const HIGHLIGHT_BORDER = '#F3C551'
/** 「按司机」用另一种颜色，跟「按产品」区分开——两者日期口径不同（送货日 vs 确认日） */
const DRIVER_BG = '#DBEAFE'
const DRIVER_BORDER = '#60A5FA'
/** 「按客户」（某天全量客户构成，非某产品下的客户）用第三种颜色，跟前两者区分 */
const CUSTOMER_BG = '#D1FAE5'
const CUSTOMER_BORDER = '#34D399'

interface BucketRow {
  key: string
  name: string
  qty: number
  avgPrice: number
  revenueExTax: number
  totalIncTax: number
  grossProfit: number
}

interface BucketPayload {
  summary: { revenueExTax: number; totalIncTax: number; grossProfit: number }
  rows: BucketRow[]
}

interface DriverDaySalesRow {
  driverId: string | null
  driverName: string
  totalIncTax: number
  revenueExTax: number
  grossProfit: number
  commissionTotal: number
}

/** 把周维度的 key（'2026-W31'，见 lib/analytics/pivot.ts DIMENSION_DEFS.week）换算回该 ISO 周的公历日期范围 */
function isoWeekRange(key: string): { from: string; to: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7))
  const dow = simple.getUTCDay() || 7
  const monday = new Date(simple)
  monday.setUTCDate(simple.getUTCDate() - dow + 1)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(monday), to: fmt(sunday) }
}

function mondayOf(d: Date): Date {
  const dow = d.getDay() || 7
  const m = new Date(d)
  m.setDate(d.getDate() - dow + 1)
  m.setHours(0, 0, 0, 0)
  return m
}

function fmtYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function weekLabel(key: string, isEn: boolean): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return key
  return isEn ? `W${m[2]} ${m[1]}` : `${m[1]} 年第 ${m[2]} 周`
}

function dayLabel(key: string, isEn: boolean): string {
  const d = new Date(`${key}T00:00:00`)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString(isEn ? 'en-GB' : 'zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })
}

export default function WeeklyDrilldown({ isEn, productIds = '', customerIds = '' }: { isEn: boolean; productIds?: string; customerIds?: string }) {
  const [weeksBack, setWeeksBack] = useState(WEEKS_PAGE_SIZE)
  const [data, setData] = useState<BucketPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [daysByWeek, setDaysByWeek] = useState<Record<string, BucketRow[] | 'loading' | 'error'>>({})
  const [productDay, setProductDay] = useState<string | null>(null)
  const [productRows, setProductRows] = useState<BucketRow[] | 'loading' | 'error' | null>(null)
  // 右侧面板第二级下钻：某天 × 某产品 → 卖给了哪些客户。点产品行进，点返回/换天/关面板退
  const [selectedProduct, setSelectedProduct] = useState<BucketRow | null>(null)
  const [customerRows, setCustomerRows] = useState<BucketRow[] | 'loading' | 'error' | null>(null)
  // 「按司机」是另一条独立的钻取路径（送货日口径，跟按产品的确认日口径不是同一批订单），
  // 跟按产品/按客户互斥——同一时刻右侧只有一张明细表
  const [driverDay, setDriverDay] = useState<string | null>(null)
  const [driverRows, setDriverRows] = useState<DriverDaySalesRow[] | 'loading' | 'error' | null>(null)
  // 「按客户」：某天全量客户构成（非某产品下的客户，跟上面第二级下钻的 customerRows 是两回事）
  const [customerDay, setCustomerDay] = useState<string | null>(null)
  const [customerDayRows, setCustomerDayRows] = useState<BucketRow[] | 'loading' | 'error' | null>(null)

  const extraFilterQs = (customerIds ? `&customerId=${encodeURIComponent(customerIds)}` : '') + (productIds ? `&productId=${encodeURIComponent(productIds)}` : '')

  const load = useCallback(() => {
    setError(null)
    const today = new Date()
    const from = fmtYMD(new Date(mondayOf(today).getTime() - (weeksBack - 1) * 7 * 86400000))
    const to = fmtYMD(today)
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=week&from=${from}&to=${to}${extraFilterQs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [weeksBack, extraFilterQs])

  useEffect(() => { load() }, [load])

  // 产品/客户筛选变了：之前展开/下钻的日、产品、司机、客户明细都是按旧筛选拉的，全部失效重置，
  // 避免面板里挂着一份跟当前筛选对不上的数据
  useEffect(() => {
    setExpanded({})
    setDaysByWeek({})
    setProductDay(null)
    setProductRows(null)
    setSelectedProduct(null)
    setCustomerRows(null)
    setDriverDay(null)
    setDriverRows(null)
    setCustomerDay(null)
    setCustomerDayRows(null)
  }, [productIds, customerIds])

  function toggleWeek(row: BucketRow) {
    const willExpand = !expanded[row.key]
    setExpanded((prev) => ({ ...prev, [row.key]: willExpand }))
    if (willExpand && !daysByWeek[row.key]) {
      const range = isoWeekRange(row.key)
      if (!range) return
      setDaysByWeek((prev) => ({ ...prev, [row.key]: 'loading' }))
      apiGet<BucketPayload>(`/api/analytics/margin?groupBy=day&from=${range.from}&to=${range.to}${extraFilterQs}`)
        .then((payload) => setDaysByWeek((prev) => ({ ...prev, [row.key]: payload.rows })))
        .catch(() => setDaysByWeek((prev) => ({ ...prev, [row.key]: 'error' })))
    }
  }

  function toggleProductDetail(dayKey: string) {
    setSelectedProduct(null)
    setCustomerRows(null)
    setDriverDay(null)
    setDriverRows(null)
    setCustomerDay(null)
    setCustomerDayRows(null)
    if (productDay === dayKey) {
      setProductDay(null)
      setProductRows(null)
      return
    }
    setProductDay(dayKey)
    setProductRows('loading')
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=product&from=${dayKey}&to=${dayKey}${extraFilterQs}`)
      .then((payload) => setProductRows(payload.rows))
      .catch(() => setProductRows('error'))
  }

  // 送货日口径（waveDate），跟上面按产品的确认日口径不是同一批订单——两者互斥，
  // 打开一个会关掉另一个，避免右侧同时出现两张口径不同的表让人误以为是同一批数据
  function toggleDriverDetail(dayKey: string) {
    setProductDay(null)
    setProductRows(null)
    setSelectedProduct(null)
    setCustomerRows(null)
    setCustomerDay(null)
    setCustomerDayRows(null)
    if (driverDay === dayKey) {
      setDriverDay(null)
      setDriverRows(null)
      return
    }
    setDriverDay(dayKey)
    setDriverRows('loading')
    apiGet<{ rows: DriverDaySalesRow[] }>(`/api/analytics/driver-commission/day-sales?from=${dayKey}&to=${dayKey}`)
      .then((payload) => setDriverRows(payload.rows))
      .catch(() => setDriverRows('error'))
  }

  // 某天全量客户构成（确认日口径，跟按产品同口径），跟按产品/按司机互斥
  function toggleCustomerDayDetail(dayKey: string) {
    setProductDay(null)
    setProductRows(null)
    setSelectedProduct(null)
    setCustomerRows(null)
    setDriverDay(null)
    setDriverRows(null)
    if (customerDay === dayKey) {
      setCustomerDay(null)
      setCustomerDayRows(null)
      return
    }
    setCustomerDay(dayKey)
    setCustomerDayRows('loading')
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=customer&from=${dayKey}&to=${dayKey}${extraFilterQs}`)
      .then((payload) => setCustomerDayRows(payload.rows))
      .catch(() => setCustomerDayRows('error'))
  }

  function openCustomerBreakdown(product: BucketRow) {
    if (!productDay) return
    setSelectedProduct(product)
    setCustomerRows('loading')
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=customer&from=${productDay}&to=${productDay}&productId=${encodeURIComponent(product.key)}${customerIds ? `&customerId=${encodeURIComponent(customerIds)}` : ''}`)
      .then((payload) => setCustomerRows(payload.rows))
      .catch(() => setCustomerRows('error'))
  }

  function backToProducts() {
    setSelectedProduct(null)
    setCustomerRows(null)
  }

  if (error) {
    return <div className="text-center text-red-500 py-16 text-sm">{error}</div>
  }
  if (!data) {
    return <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
  }

  // /api/analytics/margin 非透视分支按毛利降序排（给毛利分析页用），不是按时间——
  // 这里必须显式按 key（'YYYY-Www' / 'YYYY-MM-DD'）升序重排，不能假设 API 返回顺序
  const rowsAsc = [...data.rows].sort((a, b) => a.key.localeCompare(b.key))
  // API 汇总(summary)不带 qty —— 总数量/总均价用各周行相加/推导，跟各行的 qty/avgPrice 口径一致
  const totalQty = rowsAsc.reduce((s, r) => s + r.qty, 0)
  const totalAvgPrice = totalQty > 0 ? data.summary.revenueExTax / totalQty : 0

  // 导出当前已经展开/下钻到的全部内容（周→已展开的日→已打开的产品→已选中客户），
  // 折叠/没点开的部分不在导出范围——跟屏幕上看到的保持一致，不额外发请求硬拉全量
  function exportCsv() {
    if (!data) return
    const levelLabel = {
      total: isEn ? 'Total' : '总计', week: isEn ? 'Week' : '周', day: isEn ? 'Day' : '日',
      product: isEn ? 'Product' : '产品', customer: isEn ? 'Customer' : '客户', driver: isEn ? 'Driver' : '司机',
    }
    const rows: string[][] = []
    const pushRow = (level: keyof typeof levelLabel, name: string, r: { qty?: number; avgPrice?: number; revenueExTax: number; totalIncTax: number; grossProfit: number }, commission?: number) =>
      rows.push([levelLabel[level], name, r.qty === undefined ? '' : String(r.qty), r.avgPrice === undefined ? '' : fmtMoney(r.avgPrice), fmtMoney(r.totalIncTax), fmtMoney(r.revenueExTax), fmtMoney(r.grossProfit), commission === undefined ? '' : fmtMoney(commission)])

    pushRow('total', levelLabel.total, data.summary)
    for (const week of rowsAsc) {
      pushRow('week', weekLabel(week.key, isEn), week)
      const days = daysByWeek[week.key]
      if (!expanded[week.key] || !Array.isArray(days)) continue
      for (const d of [...days].sort((a, b) => a.key.localeCompare(b.key))) {
        pushRow('day', dayLabel(d.key, isEn), d)
        if (productDay === d.key && Array.isArray(productRows)) {
          for (const p of productRows) {
            pushRow('product', p.name, p)
            if (selectedProduct?.key === p.key && Array.isArray(customerRows)) {
              for (const c of customerRows) pushRow('customer', c.name, c)
            }
          }
        }
        if (driverDay === d.key && Array.isArray(driverRows)) {
          for (const dr of driverRows) pushRow('driver', dr.driverName, dr, dr.commissionTotal)
        }
        if (customerDay === d.key && Array.isArray(customerDayRows)) {
          for (const c of customerDayRows) pushRow('customer', c.name, c)
        }
      }
    }

    const headers = [isEn ? 'Level' : '层级', isEn ? 'Name' : '名称', isEn ? 'Qty' : '数量', isEn ? 'Avg Price' : '价格', isEn ? 'Total' : '总额', isEn ? 'Untaxed Total' : '未税总额', isEn ? 'Margin' : '毛利', isEn ? 'Commission' : '提成']
    downloadCsv(`sales-analysis-weekly-${new Date().toISOString().slice(0, 10)}`, headers, rows)
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
          title={isEn ? 'Export the currently expanded rows (week/day/product/customer) as CSV' : '导出当前已展开的内容（周/日/产品/客户）为 CSV'}
        >
          ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
        </button>
      </div>
      <div className="flex flex-col lg:flex-row gap-4 items-start">
      <div className={((productDay || driverDay || customerDay) ? 'lg:w-[480px] lg:shrink-0 ' : 'flex-1 ') + 'bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden overflow-x-auto'}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-3 py-3 font-semibold text-gray-600">{isEn ? 'Week' : '周'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Avg Price' : '价格'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Total' : '总额'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Untaxed Total' : '未税总额'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-gray-100 bg-gray-50 font-bold">
            <td className="px-3 py-2.5 text-gray-700">{isEn ? 'Total' : '总计'}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{Math.round(totalQty * 1000) / 1000}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(totalAvgPrice)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.totalIncTax)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.revenueExTax)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.grossProfit)}</td>
          </tr>
          {rowsAsc.length === 0 && (
            <tr><td colSpan={6} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
          )}
          {rowsAsc.map((row) => {
            const isOpen = !!expanded[row.key]
            const days = daysByWeek[row.key]
            return (
              <Fragment key={row.key}>
                <tr
                  className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                  onClick={() => toggleWeek(row)}
                >
                  <td className="px-3 py-2.5 flex items-center gap-2">
                    <span className="w-3 text-gray-400 inline-block" style={{ color: PURPLE }}>{isOpen ? '−' : '+'}</span>
                    {weekLabel(row.key, isEn)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{Math.round(row.qty * 1000) / 1000}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.avgPrice)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.totalIncTax)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.revenueExTax)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.grossProfit)}</td>
                </tr>
                {isOpen && days === 'loading' && (
                  <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {isOpen && days === 'error' && (
                  <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                )}
                {isOpen && Array.isArray(days) && [...days].sort((a, b) => a.key.localeCompare(b.key)).map((d) => {
                  const isProductOpen = productDay === d.key
                  const isDriverOpen = driverDay === d.key
                  const isCustomerOpen = customerDay === d.key
                  return (
                    <tr
                      key={d.key}
                      className="border-b border-gray-50 text-gray-500"
                      style={isProductOpen ? { background: HIGHLIGHT_BG } : isDriverOpen ? { background: DRIVER_BG } : isCustomerOpen ? { background: CUSTOMER_BG } : undefined}
                    >
                      <td className="pl-10 pr-5 py-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => toggleProductDetail(d.key)}
                          className="mr-1 w-5 h-5 shrink-0 rounded border align-middle text-xs leading-none"
                          style={isProductOpen
                            ? { borderColor: HIGHLIGHT_BORDER, background: 'white', color: '#92700F' }
                            : { borderColor: '#e5e7eb', color: '#9ca3af' }}
                          title={isEn ? 'By product' : '按产品明细'}
                        >
                          ▤
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleCustomerDayDetail(d.key)}
                          className="mr-1 w-5 h-5 shrink-0 rounded border align-middle text-xs leading-none"
                          style={isCustomerOpen
                            ? { borderColor: CUSTOMER_BORDER, background: 'white', color: '#047857' }
                            : { borderColor: '#e5e7eb', color: '#9ca3af' }}
                          title={isEn ? 'By customer' : '按客户明细'}
                        >
                          👥
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleDriverDetail(d.key)}
                          className="mr-2 w-5 h-5 shrink-0 rounded border align-middle text-xs leading-none"
                          style={isDriverOpen
                            ? { borderColor: DRIVER_BORDER, background: 'white', color: '#1D4ED8' }
                            : { borderColor: '#e5e7eb', color: '#9ca3af' }}
                          title={isEn ? 'By driver (delivery date)' : '按司机（送货日口径）'}
                        >
                          🚚
                        </button>
                        {dayLabel(d.key, isEn)}
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{Math.round(d.qty * 1000) / 1000}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.avgPrice)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.totalIncTax)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.revenueExTax)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.grossProfit)}</td>
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <div className="text-center py-3 border-t border-gray-50">
        <button
          onClick={() => setWeeksBack((n) => n + WEEKS_PAGE_SIZE)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400"
        >
          {isEn ? 'Show more weeks' : '显示更多周'}
        </button>
      </div>
      </div>

      {productDay && (
        <div
          className="flex-1 min-w-0 rounded-xl shadow-sm overflow-hidden border"
          style={{ background: HIGHLIGHT_BG, borderColor: HIGHLIGHT_BORDER }}
        >
          <div className="flex items-center justify-between px-5 py-3">
            <div className="text-sm font-semibold text-gray-700 min-w-0">
              {selectedProduct ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={backToProducts}
                    className="text-xs font-normal px-1.5 py-0.5 rounded border border-transparent hover:border-gray-300 text-gray-600 shrink-0"
                    title={isEn ? 'Back to products' : '返回产品列表'}
                  >
                    ‹ {isEn ? 'Products' : '返回产品'}
                  </button>
                  <span className="text-xs text-gray-400 shrink-0">{dayLabel(productDay, isEn)}</span>
                  <span className="text-xs text-gray-400 shrink-0">›</span>
                  <span className="truncate">{selectedProduct.name}</span>
                </div>
              ) : (
                <>
                  {isEn ? 'Product Detail' : '产品明细'}
                  <span className="ml-2 text-xs font-normal text-gray-500">{dayLabel(productDay, isEn)}</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => { setProductDay(null); setProductRows(null); setSelectedProduct(null); setCustomerRows(null) }}
              className="text-gray-400 hover:text-gray-600 text-sm px-1 shrink-0"
              title={isEn ? 'Close' : '关闭'}
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto max-h-[560px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5">
                  <th className="text-left px-5 py-2 font-semibold text-gray-600">
                    {selectedProduct ? (isEn ? 'Customer' : '客户') : (isEn ? 'Product' : '产品')}
                  </th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Total' : '总额'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Untaxed' : '未税'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
                </tr>
              </thead>
              <tbody>
                {!selectedProduct && productRows === 'loading' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {!selectedProduct && productRows === 'error' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                )}
                {!selectedProduct && Array.isArray(productRows) && productRows.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {!selectedProduct && Array.isArray(productRows) && productRows.map((p) => (
                  <tr
                    key={p.key}
                    className="border-b border-black/5 cursor-pointer hover:bg-black/5"
                    onClick={() => openCustomerBreakdown(p)}
                    title={isEn ? 'See which customers bought this' : '看看这个产品卖给了哪些客户'}
                  >
                    <td className="px-5 py-1.5 text-gray-700">{p.name}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(p.totalIncTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(p.revenueExTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(p.grossProfit)}</td>
                  </tr>
                ))}
                {selectedProduct && customerRows === 'loading' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {selectedProduct && customerRows === 'error' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                )}
                {selectedProduct && Array.isArray(customerRows) && customerRows.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {selectedProduct && Array.isArray(customerRows) && customerRows.map((c) => (
                  <tr key={c.key} className="border-b border-black/5">
                    <td className="px-5 py-1.5 text-gray-700">{c.name}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.totalIncTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.revenueExTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.grossProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {driverDay && (
        <div
          className="flex-1 min-w-0 rounded-xl shadow-sm overflow-hidden border"
          style={{ background: DRIVER_BG, borderColor: DRIVER_BORDER }}
        >
          <div className="flex items-center justify-between px-5 py-3">
            <div className="text-sm font-semibold text-gray-700 min-w-0">
              {isEn ? 'By Driver' : '按司机'}
              <span className="ml-2 text-xs font-normal text-gray-500">
                {dayLabel(driverDay, isEn)} · {isEn ? 'delivery date' : '送货日口径'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => { setDriverDay(null); setDriverRows(null) }}
              className="text-gray-400 hover:text-gray-600 text-sm px-1 shrink-0"
              title={isEn ? 'Close' : '关闭'}
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto max-h-[560px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5">
                  <th className="text-left px-5 py-2 font-semibold text-gray-600">{isEn ? 'Driver' : '司机'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Total' : '总额'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Commission' : '提成'}</th>
                </tr>
              </thead>
              <tbody>
                {driverRows === 'loading' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {driverRows === 'error' && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-red-500">
                    {isEn ? 'Failed to load (you may not have permission to view commission data)' : '加载失败（可能没有查看提成数据的权限）'}
                  </td></tr>
                )}
                {Array.isArray(driverRows) && driverRows.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-10 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {Array.isArray(driverRows) && driverRows.map((r) => (
                  <tr key={r.driverId ?? r.driverName} className="border-b border-black/5">
                    <td className="px-5 py-1.5 text-gray-700">{r.driverName}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(r.totalIncTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(r.grossProfit)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums font-medium" style={{ color: DRIVER_BORDER }}>{eur(r.commissionTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {customerDay && (
        <div
          className="flex-1 min-w-0 rounded-xl shadow-sm overflow-hidden border"
          style={{ background: CUSTOMER_BG, borderColor: CUSTOMER_BORDER }}
        >
          <div className="flex items-center justify-between px-5 py-3">
            <div className="text-sm font-semibold text-gray-700 min-w-0">
              {isEn ? 'By Customer' : '按客户'}
              <span className="ml-2 text-xs font-normal text-gray-500">{dayLabel(customerDay, isEn)}</span>
            </div>
            <button
              type="button"
              onClick={() => { setCustomerDay(null); setCustomerDayRows(null) }}
              className="text-gray-400 hover:text-gray-600 text-sm px-1 shrink-0"
              title={isEn ? 'Close' : '关闭'}
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto max-h-[560px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5">
                  <th className="text-left px-5 py-2 font-semibold text-gray-600">{isEn ? 'Customer' : '客户'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Total' : '总额'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Untaxed' : '未税'}</th>
                  <th className="text-right px-5 py-2 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
                </tr>
              </thead>
              <tbody>
                {customerDayRows === 'loading' && (
                  <tr><td colSpan={5} className="text-center py-10 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {customerDayRows === 'error' && (
                  <tr><td colSpan={5} className="text-center py-10 text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                )}
                {Array.isArray(customerDayRows) && customerDayRows.length === 0 && (
                  <tr><td colSpan={5} className="text-center py-10 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                )}
                {Array.isArray(customerDayRows) && customerDayRows.map((c) => (
                  <tr key={c.key} className="border-b border-black/5">
                    <td className="px-5 py-1.5 text-gray-700">{c.name}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{Math.round(c.qty * 1000) / 1000}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.totalIncTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.revenueExTax)}</td>
                    <td className="text-right px-5 py-1.5 tabular-nums">{eur(c.grossProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
