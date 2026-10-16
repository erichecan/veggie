'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiPost } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { formatDateOnly } from '@/lib/format-date'
import { downloadCsv } from '@/lib/csv-export'
import type { FilterSpec, ReportRequest } from '@/lib/reports/types'
import { nextDay } from './date-range'
import { productLabel } from './product-label'

/**
 * 采购分析：明细表（按采购单逐行，可展开看该单下的商品）
 * ============================================================================
 * 20260922 客户要求：矩阵视图(SupplierMonthMatrix)只看得到汇总数字，核对某一笔
 * 供应商发票时需要逐单看——审批日期、供应商发票参考号、供应商、数量、金额。这些字段
 * 一个 PO 只有一份（供应商发票参考号挂在 VendorBill 上，一个 PO 至多一张账单），所以用
 * po_name 等维度一起 GROUP BY，效果就是"一行一个采购单"，不需要另开接口。
 *
 * 20261015 客户要求加「价格」列 + 按产品展开：
 * - 价格 = 金额/数量（该 PO 下所有行按数量加权的均价），跟分层明细 tab 的「平均价格」
 *   口径一致，不用新加 unit_cost 度量，前端直接算。
 * - 展开后的产品级价格用同一个口径（该产品那一行的 subtotal_ex_tax/ordered_qty），
 *   不读 unit_cost——一个 PO 里同一产品正常只有一行，两种口径数值相同；万一有多行
 *   （如分批加价重复下单），按数量加权比简单平均更贴近「这批货花了多少钱」。
 * - 系统发票号(Bill No.)这一列客户没再要求保留，20261015 按客户给的新列序去掉了，
 *   数据本身还在 VendorBill 上，不是删掉了这个能力，只是不在这张表露出来。
 *
 * ⛔ 数量/金额口径与矩阵视图一致：只统计已确认及之后的采购单
 * （COUNTED_STATUSES），金额是原币 subtotal_ex_tax——理由见 SupplierMonthMatrix.tsx 顶部注释。
 */

const COUNTED_STATUSES = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']
/** 一次取回的采购单数上限。超了在表头挂告警，不静默截断 */
const ROW_LIMIT = 3000
/** 单个 PO 展开后的产品行数上限，足够覆盖正常单据 */
const PRODUCT_ROW_LIMIT = 500

interface ApiRow {
  po_name: string | null
  supplier_name: string | null
  confirmed_at: string | null
  vendor_bill_ref: string | null
  subtotal_ex_tax: string | number | null
  ordered_qty: string | number | null
}

interface ApiResponse {
  rows: ApiRow[]
  totals: Record<string, number>
  total: number
}

interface ProductRow {
  product_name: string | null
  product_spec: string | null
  description: string | null
  subtotal_ex_tax: string | number | null
  ordered_qty: string | number | null
}

const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const unitPrice = (amount: number, qty: number) => (qty ? amount / qty : 0)

export default function PurchaseOrderDetailTable({
  isEn, supplierIds, productIds, supplierTerms, productTerms, from, to,
}: {
  isEn: boolean
  supplierIds: string[]
  productIds: string[]
  supplierTerms: string[]
  productTerms: string[]
  from: string
  to: string
}) {
  const scope = `${supplierIds.join(',')}|${productIds.join(',')}|${supplierTerms.join(',')}|${productTerms.join(',')}|${from}|${to}`
  const [loaded, setLoaded] = useState<{ scope: string; res: ApiResponse } | null>(null)
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [products, setProducts] = useState<Record<string, { status: 'loading' | 'loaded' | 'error'; rows: ProductRow[]; message?: string }>>({})

  const buildBody = useCallback((): ReportRequest => {
    const filters: FilterSpec[] = [
      { field: 'order_date', operator: '>=', value: from },
      { field: 'order_date', operator: '<', value: nextDay(to) },
      { field: 'po_status', operator: 'in', value: COUNTED_STATUSES },
    ]
    if (supplierIds.length) filters.push({ field: 'supplier_id', operator: 'in', value: supplierIds })
    if (productIds.length) filters.push({ field: 'product_id', operator: 'in', value: productIds })
    return {
      rowDimensions: [
        { field: 'po_name' },
        { field: 'supplier_name' },
        { field: 'confirmed_at' },
        { field: 'vendor_bill_ref' },
      ],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      filters,
      orFilters: supplierTerms.map((term) => ({ field: 'supplier_name', operator: 'like' as const, value: term })),
      orFilterGroups: productTerms.length ? [productTerms.map((term) => ({ field: 'product_name', operator: 'like' as const, value: term }))] : [],
      orderBy: [{ field: 'confirmed_at', direction: 'desc' }],
      limit: ROW_LIMIT,
    }
  }, [from, to, supplierIds, productIds, supplierTerms, productTerms])

  useEffect(() => {
    let cancelled = false
    const reqScope = scope
    apiPost<ApiResponse>('/api/reports/purchasing', buildBody())
      .then((res) => { if (!cancelled) { setLoaded({ scope: reqScope, res }); setFailure(null) } })
      .catch((e) => {
        if (!cancelled) setFailure({ scope: reqScope, message: e instanceof Error ? e.message : String(e) })
      })
    return () => { cancelled = true }
  }, [buildBody, scope])

  // 筛选条件一变，之前展开的产品明细就不再对应当前结果集，清空重来
  // （渲染期间同步调整 state，而不是放进 useEffect——避免多一次级联渲染）
  const [expandedScope, setExpandedScope] = useState(scope)
  if (expandedScope !== scope) {
    setExpandedScope(scope)
    setExpanded({})
    setProducts({})
  }

  function toggleExpand(poName: string) {
    setExpanded((old) => ({ ...old, [poName]: !old[poName] }))
    if (products[poName]) return
    setProducts((old) => ({ ...old, [poName]: { status: 'loading', rows: [] } }))
    const request: ReportRequest = {
      rowDimensions: [{ field: 'product_name' }, { field: 'product_spec' }, { field: 'description' }],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      filters: [{ field: 'po_name', operator: '=', value: poName }],
      orderBy: [{ field: 'product_name', direction: 'asc' }],
      limit: PRODUCT_ROW_LIMIT,
    }
    apiPost<{ rows: ProductRow[] }>('/api/reports/purchasing', request)
      .then((res) => setProducts((old) => ({ ...old, [poName]: { status: 'loaded', rows: res.rows } })))
      .catch((e) => setProducts((old) => ({ ...old, [poName]: { status: 'error', rows: [], message: e instanceof Error ? e.message : String(e) } })))
  }

  const data = loaded?.res ?? null
  const error = failure?.scope === scope ? failure.message : null
  const pending = loaded?.scope !== scope && failure?.scope !== scope

  if (error) return <div className="text-center text-red-500 py-16 text-sm">{error}</div>
  if (!data) return <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>

  const rows = data.rows
  const truncated = rows.length >= ROW_LIMIT || rows.length < (data.total ?? 0)
  const grandAmount = num(data.totals?.subtotal_ex_tax)
  const grandQty = num(data.totals?.ordered_qty)

  function exportCsv() {
    const headers = isEn
      ? ['PO No.', 'Supplier', 'Price', 'Qty', 'Amount', 'Date Approved', 'Supplier Invoice Ref.']
      : ['采购单号', '供应商', '价格', '数量', '金额', '审批日期', '供应商发票参考号']
    const csvRows = rows.map((r) => {
      const amount = num(r.subtotal_ex_tax)
      const qty = num(r.ordered_qty)
      return [
        r.po_name ?? '',
        r.supplier_name ?? '',
        fmtMoney(unitPrice(amount, qty)),
        String(qty),
        fmtMoney(amount),
        r.confirmed_at ? formatDateOnly(r.confirmed_at) : '',
        r.vendor_bill_ref ?? '',
      ]
    })
    downloadCsv(`purchase-analysis-detail-${from}_${to}`, headers, csvRows)
  }

  return (
    <div>
      <div className="flex justify-between items-center gap-3 mb-2 flex-wrap">
        <span className="text-xs text-gray-400">
          {isEn
            ? 'One row per purchase order · confirmed POs and later only · click a row to expand by product'
            : '一行一个采购单 · 只计已确认及之后的采购单 · 点击某一行可按产品展开'}
        </span>
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
        >
          ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden overflow-x-auto">
        {pending && (
          <div className="px-4 py-1.5 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
            {isEn ? 'Updating… the rows below are from the previous query' : '正在更新…下面显示的还是上一次的结果'}
          </div>
        )}
        {truncated && (
          <div className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-b border-amber-100">
            {isEn
              ? `Too many purchase orders (${data.total}), showing the first ${rows.length}. Narrow the filters or shorten the period.`
              : `采购单太多（共 ${data.total} 条，只取回前 ${rows.length} 条）。请缩小筛选范围或缩短时间段。`}
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-gray-600">
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'PO No.' : '采购单号'}</th>
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Supplier' : '供应商'}</th>
              <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Price' : '价格'}</th>
              <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Qty' : '数量'}</th>
              <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Amount' : '金额'}</th>
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Date Approved' : '审批日期'}</th>
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Supplier Invoice Ref.' : '供应商发票参考号'}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100 bg-gray-50 font-bold">
              <td colSpan={3} className="px-3 py-2.5 text-gray-700">{isEn ? 'Total' : '总计'}</td>
              <td className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">{Math.round(grandQty * 1000) / 1000}</td>
              <td className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap" colSpan={3}>{eur(grandAmount)}</td>
            </tr>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
            )}
            {rows.map((r, i) => {
              const poName = r.po_name ?? ''
              const amount = num(r.subtotal_ex_tax)
              const qty = num(r.ordered_qty)
              const isOpen = !!expanded[poName]
              const productState = products[poName]
              return (
                <Fragment key={`${poName}|${i}`}>
                  <tr
                    className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                    onClick={() => poName && toggleExpand(poName)}
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-gray-800">
                      <span className="inline-block w-4 text-purple-800">{poName ? (isOpen ? '−' : '+') : ''}</span>
                      {r.po_name ?? '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-800">{r.supplier_name ?? (isEn ? '(not flagged as vendor)' : '（档案未标记为供应商）')}</td>
                    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap text-gray-800">{eur(unitPrice(amount, qty))}</td>
                    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap text-gray-800">{Math.round(qty * 1000) / 1000}</td>
                    <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap text-gray-800">{eur(amount)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.confirmed_at ? formatDateOnly(r.confirmed_at) : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.vendor_bill_ref ?? <span className="text-gray-300">—</span>}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={7} className="px-3 py-2">
                        {!productState || productState.status === 'loading' ? (
                          <div className="text-xs text-gray-400 py-2">{isEn ? 'Loading products…' : '加载商品明细中…'}</div>
                        ) : productState.status === 'error' ? (
                          <div className="text-xs text-red-500 py-2">{productState.message}</div>
                        ) : (
                          <table className="w-full text-xs">
                            <tbody>
                              {productState.rows.map((pr, pi) => {
                                const pAmount = num(pr.subtotal_ex_tax)
                                const pQty = num(pr.ordered_qty)
                                return (
                                  <tr key={`${poName}-p${pi}`} className="border-b border-gray-100 last:border-0">
                                    <td className="py-1.5 pl-6 text-gray-700">{productLabel(pr.product_name ?? (isEn ? '(unknown product)' : '（未知产品）'), pr.product_spec, pr.description)}</td>
                                    <td className="py-1.5 text-right tabular-nums text-gray-600 w-28">{eur(unitPrice(pAmount, pQty))}</td>
                                    <td className="py-1.5 text-right tabular-nums text-gray-600 w-24">{Math.round(pQty * 1000) / 1000}</td>
                                    <td className="py-1.5 text-right tabular-nums text-gray-600 w-28">{eur(pAmount)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
