'use client'
import { useCallback, useEffect, useState } from 'react'
import { apiPost } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { formatDateOnly } from '@/lib/format-date'
import { downloadCsv } from '@/lib/csv-export'
import type { FilterSpec, ReportRequest } from '@/lib/reports/types'
import { nextDay } from './date-range'

/**
 * 采购分析：明细表（按采购单逐行）
 * ============================================================================
 * 20260922 客户要求：矩阵视图(SupplierMonthMatrix)只看得到汇总数字，核对某一笔
 * 供应商发票时需要逐单看——审批日期、供应商发票参考号、系统生成的账单号、供应商、
 * 数量、金额。这些字段一个 PO 只有一份（供应商发票参考号/账单号挂在 VendorBill 上，
 * 一个 PO 至多一张账单），所以用 po_name 等 5 个维度一起 GROUP BY，
 * 效果就是"一行一个采购单"，不需要另开接口。
 *
 * ⛔ 数量/金额口径与矩阵视图一致：只统计已确认及之后的采购单
 * （COUNTED_STATUSES），金额是原币 subtotal_ex_tax——理由见 SupplierMonthMatrix.tsx 顶部注释。
 */

const COUNTED_STATUSES = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']
/** 一次取回的采购单数上限。超了在表头挂告警，不静默截断 */
const ROW_LIMIT = 3000

interface ApiRow {
  po_name: string | null
  supplier_name: string | null
  confirmed_at: string | null
  vendor_bill_no: string | null
  vendor_bill_ref: string | null
  subtotal_ex_tax: string | number | null
  ordered_qty: string | number | null
}

interface ApiResponse {
  rows: ApiRow[]
  totals: Record<string, number>
  total: number
}

const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export default function PurchaseOrderDetailTable({
  isEn, supplierIds, productIds, from, to,
}: {
  isEn: boolean
  supplierIds: string[]
  productIds: string[]
  from: string
  to: string
}) {
  const scope = `${supplierIds.join(',')}|${productIds.join(',')}|${from}|${to}`
  const [loaded, setLoaded] = useState<{ scope: string; res: ApiResponse } | null>(null)
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)

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
        { field: 'vendor_bill_no' },
        { field: 'vendor_bill_ref' },
      ],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      filters,
      orderBy: [{ field: 'confirmed_at', direction: 'desc' }],
      limit: ROW_LIMIT,
    }
  }, [from, to, supplierIds, productIds])

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
      ? ['PO No.', 'Supplier', 'Date Approved', 'Supplier Invoice Ref.', 'Bill No.', 'Qty', 'Amount']
      : ['采购单号', '供应商', '审批日期', '供应商发票参考号', '系统发票号', '数量', '金额']
    const csvRows = rows.map((r) => [
      r.po_name ?? '',
      r.supplier_name ?? '',
      r.confirmed_at ? formatDateOnly(r.confirmed_at) : '',
      r.vendor_bill_ref ?? '',
      r.vendor_bill_no ?? '',
      String(num(r.ordered_qty)),
      fmtMoney(num(r.subtotal_ex_tax)),
    ])
    downloadCsv(`purchase-analysis-detail-${from}_${to}`, headers, csvRows)
  }

  return (
    <div>
      <div className="flex justify-between items-center gap-3 mb-2 flex-wrap">
        <span className="text-xs text-gray-400">
          {isEn
            ? 'One row per purchase order · confirmed POs and later only'
            : '一行一个采购单 · 只计已确认及之后的采购单'}
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
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Date Approved' : '审批日期'}</th>
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Supplier Invoice Ref.' : '供应商发票参考号'}</th>
              <th className="text-left px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Bill No.' : '系统发票号'}</th>
              <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Qty' : '数量'}</th>
              <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">{isEn ? 'Amount' : '金额'}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100 bg-gray-50 font-bold">
              <td colSpan={5} className="px-3 py-2.5 text-gray-700">{isEn ? 'Total' : '总计'}</td>
              <td className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">{Math.round(grandQty * 1000) / 1000}</td>
              <td className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">{eur(grandAmount)}</td>
            </tr>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.po_name}|${i}`} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap text-gray-800">{r.po_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-800">{r.supplier_name ?? (isEn ? '(not flagged as vendor)' : '（档案未标记为供应商）')}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.confirmed_at ? formatDateOnly(r.confirmed_at) : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.vendor_bill_ref ?? <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600 font-mono text-xs">{r.vendor_bill_no ?? <span className="text-gray-300 font-sans">—</span>}</td>
                <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap text-gray-800">{Math.round(num(r.ordered_qty) * 1000) / 1000}</td>
                <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap text-gray-800">{eur(num(r.subtotal_ex_tax))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
