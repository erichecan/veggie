'use client'
import { useState, useEffect, useMemo } from 'react'
import { apiGet } from '@/lib/api'
import { downloadCsv } from '@/lib/csv-export'
import type { Order, OrderItem } from '@/lib/types'

type SaleOrder = Order & { salesman?: string | null }

const BTN = 'px-4 py-1.5 text-sm font-medium text-white rounded transition-colors'
const BTN_STYLE = { background: '#875A7B' }
const BTN_HOVER = '#7a5070'

const PRODUCT_TYPES = [
  { value: '', label: '全部' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'service', label: 'Service' },
  { value: 'storable', label: 'Stockable Product' },
]

function TagInput({
  label, values, suggestions, onAdd, onRemove,
}: {
  label: string
  values: string[]
  suggestions: string[]
  onAdd: (v: string) => void
  onRemove: (v: string) => void
}) {
  const [input, setInput] = useState('')
  const filtered = suggestions.filter(s => !values.includes(s) && s.toLowerCase().includes(input.toLowerCase()))

  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: '#875A7B' }}>{label}</label>
      <div className="border rounded px-2 py-1 min-h-[36px] flex flex-wrap gap-1" style={{ borderColor: '#d4b8d0' }}>
        {values.map(v => (
          <span key={v} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-white" style={{ background: '#875A7B' }}>
            {v}
            <button onClick={() => onRemove(v)} className="leading-none">&times;</button>
          </span>
        ))}
        <div className="relative flex-1 min-w-[80px]">
          <input
            className="w-full text-xs outline-none py-0.5"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={values.length === 0 ? '输入搜索...' : ''}
          />
          {input && filtered.length > 0 && (
            <div className="absolute z-10 top-full left-0 w-48 bg-white border shadow-lg rounded text-xs max-h-40 overflow-y-auto" style={{ borderColor: '#d4b8d0' }}>
              {filtered.map(s => (
                <div key={s} className="px-3 py-1.5 cursor-pointer hover:bg-purple-50" onClick={() => { onAdd(s); setInput('') }}>
                  {s}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LineSelector({
  label, values, suggestions, onAdd, onRemove,
}: {
  label: string
  values: string[]
  suggestions: string[]
  onAdd: (v: string) => void
  onRemove: (v: string) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = suggestions.filter(s => !values.includes(s) && s.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="border rounded" style={{ borderColor: '#d4b8d0' }}>
      <div className="px-3 py-2 text-xs font-medium border-b" style={{ borderColor: '#d4b8d0', color: '#875A7B' }}>{label}</div>
      {values.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {values.map(v => (
              <tr key={v} className="border-b last:border-0" style={{ borderColor: '#f0e4ee' }}>
                <td className="px-3 py-1.5">{v}</td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => onRemove(v)} className="text-red-400 hover:text-red-600">&times; 删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="px-3 py-2 flex gap-2 items-center">
        <input
          className="flex-1 text-xs border rounded px-2 py-1 outline-none"
          style={{ borderColor: '#d4b8d0' }}
          placeholder="搜索并添加..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && filtered.length > 0 && (
          <div className="text-xs text-gray-500">
            {filtered.slice(0, 5).map(s => (
              <button key={s} onClick={() => { onAdd(s); setSearch('') }} className="block text-left px-2 py-0.5 hover:text-purple-700">
                + {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function openPrintWindow(title: string, html: string) {
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
  h2 { font-size: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #875A7B; color: white; padding: 6px 8px; text-align: left; font-size: 11px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 11px; }
  tr:nth-child(even) td { background: #faf5ff; }
  .total-row td { font-weight: bold; border-top: 2px solid #875A7B; }
  @media print { body { margin: 0; } }
</style></head><body>${html}</body></html>`)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 300)
}

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB')
}

export default function SalesReportPage() {
  const [orders, setOrders] = useState<SaleOrder[]>([])
  const [loading, setLoading] = useState(true)

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedSalesmen, setSelectedSalesmen] = useState<string[]>([])
  const [isQuotation, setIsQuotation] = useState(false)
  const [noSequence, setNoSequence] = useState(false)
  const [productType, setProductType] = useState('')
  const [filterCustomers, setFilterCustomers] = useState<string[]>([])
  const [filterProducts, setFilterProducts] = useState<string[]>([])

  useEffect(() => {
    apiGet<SaleOrder[]>('/api/orders?include_lines=false').then(data => {
      setOrders(Array.isArray(data) ? data : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const allSalesmen = useMemo(() => {
    const s = new Set<string>()
    orders.forEach(o => { if (o.salesman) s.add(o.salesman) })
    return Array.from(s).sort()
  }, [orders])

  const allCustomers = useMemo(() => {
    const s = new Set<string>()
    orders.forEach(o => { if (o.restaurantName) s.add(o.restaurantName) })
    return Array.from(s).sort()
  }, [orders])

  const allProducts = useMemo(() => {
    const s = new Set<string>()
    orders.forEach(o => {
      (o.items ?? []).forEach((it: OrderItem) => { if (it.productName) s.add(it.productName) })
    })
    return Array.from(s).sort()
  }, [orders])

  const filtered = useMemo(() => {
    return orders.filter(o => {
      const confirmedStatuses = ['CONFIRMED', 'COMPLETED', 'DELIVERED', 'INVOICED']
      if (!isQuotation && !confirmedStatuses.includes(String(o.status))) return false

      const orderDate = o.confirmationDate ?? o.quotationDate
      if (dateFrom && orderDate && new Date(orderDate) < new Date(dateFrom)) return false
      if (dateTo && orderDate && new Date(orderDate) > new Date(dateTo + 'T23:59:59')) return false

      if (selectedSalesmen.length > 0 && !selectedSalesmen.includes(o.salesman ?? '')) return false
      if (filterCustomers.length > 0 && !filterCustomers.includes(o.restaurantName ?? '')) return false

      if (filterProducts.length > 0) {
        const orderProductNames = (o.items ?? []).map((it: OrderItem) => it.productName)
        if (!filterProducts.some(p => orderProductNames.includes(p))) return false
      }

      return true
    })
  }, [orders, dateFrom, dateTo, selectedSalesmen, isQuotation, filterCustomers, filterProducts])

  function printSaleSummary() {
    const byCustomer = new Map<string, { count: number; total: number }>()
    filtered.forEach(o => {
      const name = o.restaurantName ?? '未知客户'
      const prev = byCustomer.get(name) ?? { count: 0, total: 0 }
      byCustomer.set(name, { count: prev.count + 1, total: prev.total + Number(o.totalAmount ?? 0) })
    })
    const grandTotal = filtered.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0)
    const rows = Array.from(byCustomer.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, { count, total }]) =>
        `<tr><td>${name}</td><td>${count}</td><td style="text-align:right">¥${fmt(total)}</td></tr>`
      ).join('')

    openPrintWindow('Sales Summary', `
      <h2>Sales Summary Report</h2>
      <p style="font-size:11px;color:#666;margin-bottom:12px">
        ${dateFrom || ''}${dateFrom && dateTo ? ' ~ ' : ''}${dateTo || ''}
        &nbsp;&nbsp;共 ${filtered.length} 单
      </p>
      <table>
        <thead><tr><th>客户</th><th>订单数</th><th style="text-align:right">合计金额</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="total-row"><td colspan="2">合计</td><td style="text-align:right">¥${fmt(grandTotal)}</td></tr></tfoot>
      </table>`)
  }

  function printMultiLine() {
    const rows: string[] = []
    filtered.forEach(o => {
      const date = fmtDate(o.confirmationDate ?? o.quotationDate)
      ;(o.items ?? []).forEach((it: OrderItem) => {
        rows.push(`<tr>
          <td>${date}</td>
          <td>${o.code ?? o.id.slice(0, 8)}</td>
          <td>${o.restaurantName ?? ''}</td>
          <td>${o.salesman ?? ''}</td>
          <td>${it.productName ?? ''}</td>
          <td style="text-align:right">${it.quantity ?? ''}</td>
          <td style="text-align:right">${it.price != null ? '¥' + fmt(Number(it.price)) : ''}</td>
          <td style="text-align:right">${it.subtotal != null ? '¥' + fmt(Number(it.subtotal)) : ''}</td>
        </tr>`)
      })
    })
    const grandTotal = filtered.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0)

    openPrintWindow('Multi Line Sales Report', `
      <h2>Multi Line Sales Report</h2>
      <p style="font-size:11px;color:#666;margin-bottom:12px">
        ${dateFrom || ''}${dateFrom && dateTo ? ' ~ ' : ''}${dateTo || ''}
        &nbsp;&nbsp;共 ${filtered.length} 单
      </p>
      <table>
        <thead><tr>
          <th>日期</th><th>单号</th><th>客户</th><th>业务员</th>
          <th>产品</th><th style="text-align:right">数量</th>
          <th style="text-align:right">单价</th><th style="text-align:right">小计</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
        <tfoot><tr class="total-row">
          <td colspan="7">合计</td>
          <td style="text-align:right">¥${fmt(grandTotal)}</td>
        </tr></tfoot>
      </table>`)
  }

  function exportCsv() {
    const rows: unknown[][] = []
    filtered.forEach(o => {
      const date = fmtDate(o.confirmationDate ?? o.quotationDate)
      const code = o.code ?? o.id.slice(0, 8)
      ;(o.items ?? []).forEach((it: OrderItem) => {
        rows.push([
          date, code, o.restaurantName ?? '', o.salesman ?? '', String(o.status ?? ''),
          it.productName ?? '', it.quantity ?? '',
          it.price != null ? Number(it.price).toFixed(2) : '',
          it.subtotal != null ? Number(it.subtotal).toFixed(2) : '',
        ])
      })
    })
    const range = [dateFrom, dateTo].filter(Boolean).join('_') || 'all'
    downloadCsv(`sales-report-${range}`,
      ['日期', '单号', '客户', '业务员', '状态', '产品', '数量', '单价', '小计'], rows)
  }

  function printOrders() {
    const rows = filtered.map(o => `<tr>
      <td>${fmtDate(o.confirmationDate ?? o.quotationDate)}</td>
      <td>${o.code ?? o.id.slice(0, 8)}</td>
      <td>${o.restaurantName ?? ''}</td>
      <td>${o.salesman ?? ''}</td>
      <td>${o.status ?? ''}</td>
      <td style="text-align:right">¥${fmt(Number(o.totalAmount ?? 0))}</td>
    </tr>`).join('')
    const grandTotal = filtered.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0)

    openPrintWindow('Sales Report', `
      <h2>Sales Report</h2>
      <p style="font-size:11px;color:#666;margin-bottom:12px">
        ${dateFrom || ''}${dateFrom && dateTo ? ' ~ ' : ''}${dateTo || ''}
        &nbsp;&nbsp;共 ${filtered.length} 单
      </p>
      <table>
        <thead><tr>
          <th>日期</th><th>单号</th><th>客户</th><th>业务员</th>
          <th>状态</th><th style="text-align:right">金额</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="total-row">
          <td colspan="5">合计</td>
          <td style="text-align:right">¥${fmt(grandTotal)}</td>
        </tr></tfoot>
      </table>`)
  }

  const inputCls = 'w-full border rounded px-2 py-1.5 text-sm outline-none'
  const inputStyle = { borderColor: '#d4b8d0' }
  const labelCls = 'block text-xs font-medium mb-1'
  const labelStyle = { color: '#875A7B' }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: '#4a2545' }}>Sales Report</h1>
        {!loading && (
          <span className="text-xs text-gray-400">已筛选 {filtered.length} 条订单</span>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">加载中...</div>
      ) : (
        <>
          {/* Filter form */}
          <div className="border rounded-lg p-4 space-y-4" style={{ borderColor: '#d4b8d0' }}>
            <div className="grid grid-cols-2 gap-6">
              {/* Left column */}
              <div className="space-y-3">
                <div>
                  <label className={labelCls} style={labelStyle}>From <span className="text-red-500">*</span></label>
                  <input type="date" className={inputCls} style={inputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                </div>
                <TagInput
                  label="Salesman"
                  values={selectedSalesmen}
                  suggestions={allSalesmen}
                  onAdd={v => setSelectedSalesmen(prev => [...prev, v])}
                  onRemove={v => setSelectedSalesmen(prev => prev.filter(x => x !== v))}
                />
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="quotations" checked={isQuotation} onChange={e => setIsQuotation(e.target.checked)} className="accent-purple-700" />
                  <label htmlFor="quotations" className="text-sm" style={{ color: '#4a2545' }}>Quotations</label>
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-3">
                <div>
                  <label className={labelCls} style={labelStyle}>To <span className="text-red-500">*</span></label>
                  <input type="date" className={inputCls} style={inputStyle} value={dateTo} onChange={e => setDateTo(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls} style={labelStyle}>Product Type</label>
                  <select className={inputCls} style={inputStyle} value={productType} onChange={e => setProductType(e.target.value)}>
                    {PRODUCT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="noSeq" checked={noSequence} onChange={e => setNoSequence(e.target.checked)} className="accent-purple-700" />
                  <label htmlFor="noSeq" className="text-sm" style={{ color: '#4a2545' }}>Sort without sequence</label>
                </div>
              </div>
            </div>

            {/* Customers */}
            <LineSelector
              label="Customers"
              values={filterCustomers}
              suggestions={allCustomers}
              onAdd={v => setFilterCustomers(prev => [...prev, v])}
              onRemove={v => setFilterCustomers(prev => prev.filter(x => x !== v))}
            />

            {/* Products */}
            <LineSelector
              label="Products"
              values={filterProducts}
              suggestions={allProducts}
              onAdd={v => setFilterProducts(prev => [...prev, v])}
              onRemove={v => setFilterProducts(prev => prev.filter(x => x !== v))}
            />
          </div>

          {/* Print buttons */}
          <div className="flex gap-3">
            <button
              className={BTN}
              style={BTN_STYLE}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = BTN_HOVER }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = BTN_STYLE.background }}
              onClick={printSaleSummary}
            >
              Print Sale Summary
            </button>
            <button
              className={BTN}
              style={BTN_STYLE}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = BTN_HOVER }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = BTN_STYLE.background }}
              onClick={printMultiLine}
            >
              Print Multi Line
            </button>
            <button
              className={BTN}
              style={BTN_STYLE}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = BTN_HOVER }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = BTN_STYLE.background }}
              onClick={printOrders}
            >
              Print
            </button>
            <button
              className={BTN}
              style={BTN_STYLE}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = BTN_HOVER }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = BTN_STYLE.background }}
              onClick={exportCsv}
            >
              导出 CSV
            </button>
          </div>

          {/* Preview table */}
          {filtered.length > 0 && (
            <div className="border rounded-lg overflow-hidden" style={{ borderColor: '#d4b8d0' }}>
              <div className="px-4 py-2 text-xs font-medium border-b" style={{ background: '#f5f0f8', borderColor: '#d4b8d0', color: '#875A7B' }}>
                预览（共 {filtered.length} 条）
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: '#f5f0f8' }}>
                      <th className="px-3 py-2 text-left font-medium" style={{ color: '#875A7B' }}>日期</th>
                      <th className="px-3 py-2 text-left font-medium" style={{ color: '#875A7B' }}>单号</th>
                      <th className="px-3 py-2 text-left font-medium" style={{ color: '#875A7B' }}>客户</th>
                      <th className="px-3 py-2 text-left font-medium" style={{ color: '#875A7B' }}>业务员</th>
                      <th className="px-3 py-2 text-left font-medium" style={{ color: '#875A7B' }}>状态</th>
                      <th className="px-3 py-2 text-right font-medium" style={{ color: '#875A7B' }}>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(o => (
                      <tr key={o.id} className="border-t" style={{ borderColor: '#f0e4ee' }}>
                        <td className="px-3 py-1.5">{fmtDate(o.confirmationDate ?? o.quotationDate)}</td>
                        <td className="px-3 py-1.5 font-mono">{o.code ?? o.id.slice(0, 8)}</td>
                        <td className="px-3 py-1.5">{o.restaurantName}</td>
                        <td className="px-3 py-1.5">{o.salesman}</td>
                        <td className="px-3 py-1.5">{o.status}</td>
                        <td className="px-3 py-1.5 text-right">¥{fmt(Number(o.totalAmount ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm border rounded-lg" style={{ borderColor: '#d4b8d0' }}>
              没有符合条件的订单
            </div>
          )}
        </>
      )}
    </div>
  )
}
