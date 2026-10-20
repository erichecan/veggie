'use client'
/**
 * 供应商账单详情 —— 20261020 客户要求「点 vendor bill 进完整详情页，做成像 sales invoice 一样」
 * 版式照 finance/invoices/[id]/page.tsx；功能是原列表页弹窗那一套（参考号回填、分笔付款、状态流转），
 * 另加原来没露出来的三单核销（GET 早就返回 reconciliation）和操作记录。
 */
import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { Button } from '@/components/ui/button'
import ActionLogPanel from '@/components/shared/action-log-panel'
import { formatDateOnly } from '@/lib/format-date'
import { VENDOR_PAYMENT_METHODS, VENDOR_PAYMENT_METHOD_LABELS } from '@/lib/finance/vendor-settlement'
import { SUPPLIER_INVOICE_REF_MAX_LEN } from '@/lib/vendor-bill-fields'
import type { ReconciliationStatus, VendorBillReconciliation } from '@/lib/vendor-bill-reconciliation'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

const PURPLE = '#875A7B'

type VbStatus = 'DRAFT' | 'POSTED' | 'PAID' | 'CANCELLED'

interface VendorBillLine {
  productId?: string
  productName: string
  qty: number
  unitCost: number
  taxRate: number
  subtotalIncTax?: number
}

interface VendorBillDetail {
  id: string
  name: string
  supplierId: string
  supplierName: string | null
  purchaseOrder: { id: string; name: string } | null
  billDate: string
  dueDate?: string | null
  createdAt: string
  postedAt?: string | null
  paidAt?: string | null
  currency?: string
  exchangeRate?: number | null
  lines: VendorBillLine[]
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  amountPaid: number
  amountDue: number
  status: VbStatus
  notes?: string | null
  supplierInvoiceRef?: string | null
  reconciliation?: VendorBillReconciliation
}

interface VendorPaymentRow {
  id: string
  amount: number
  method: string
  paidAt: string
  note: string | null
  createdBy: string | null
}

const STATUS_LABEL_ZH: Record<VbStatus, string> = { DRAFT: '草稿', POSTED: '已入账', PAID: '已付款', CANCELLED: '已作废' }
const STATUS_LABEL_EN: Record<VbStatus, string> = { DRAFT: 'Draft', POSTED: 'Posted', PAID: 'Paid', CANCELLED: 'Cancelled' }
const STATUS_COLOR: Record<VbStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  POSTED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
}

const MATCH_LABEL: Record<ReconciliationStatus, [string, string]> = {
  MATCHED: ['已核平', 'Matched'],
  OVER_RECEIVED: ['收货多于账单', 'Received more than billed'],
  UNDER_RECEIVED: ['账单多于收货', 'Billed more than received'],
}
const MATCH_COLOR: Record<ReconciliationStatus, string> = {
  MATCHED: 'bg-green-100 text-green-700',
  OVER_RECEIVED: 'bg-amber-100 text-amber-700',
  UNDER_RECEIVED: 'bg-red-100 text-red-700',
}

const money = (v: unknown) => `€${Number(v ?? 0).toFixed(2)}`
const lineExTax = (l: VendorBillLine) => Number(l.qty) * Number(l.unitCost)
const lineIncTax = (l: VendorBillLine) => Number(l.subtotalIncTax ?? lineExTax(l) * (1 + Number(l.taxRate || 0)))

export default function VendorBillDetailPage() {
  const params = useParams()
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const id = String(params.id)
  const [bill, setBill] = useState<VendorBillDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [payments, setPayments] = useState<VendorPaymentRow[]>([])
  const [busy, setBusy] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('bank')
  const [payNote, setPayNote] = useState('')
  /** 供应商发票参考号：账单大多是 PO 确认后自动生成的草稿，等财务收到供应商发票核对后回填 */
  const [refDraft, setRefDraft] = useState<string | null>(null)
  const [savingRef, setSavingRef] = useState(false)
  /** 操作记录面板只在挂载时拉一次；本页每次改动后 +1 让它重新挂载，刚做的操作立刻出现在下面 */
  const [logKey, setLogKey] = useState(0)

  const load = useCallback(async () => {
    try {
      const b = await apiGet<VendorBillDetail>(`/api/vendor-bills/${encodeURIComponent(id)}`)
      setBill(b)
      setNotFound(false)
      setLogKey(k => k + 1)
      apiGet<{ items: VendorPaymentRow[] }>(`/api/vendor-bills/${encodeURIComponent(id)}/payments`)
        .then(d => setPayments(d.items ?? []))
        .catch(() => {})
    } catch {
      setNotFound(true)
    }
  }, [id])

  useEffect(() => { load() }, [load])
  // 切回 tab 时刷新；load() 不碰 refDraft / 付款小表单，不会冲掉正在填的内容
  useRefetchOnFocus([load])

  const backToList = () => router.push(`${prefix}/classic/finance/vendor-bills`)

  async function changeStatus(status: VbStatus, label: string) {
    if (!bill) return
    if (status === 'CANCELLED' && !confirm(isEn ? 'Confirm cancelling this bill?' : '确认作废此账单？')) return
    setBusy(true)
    try {
      await apiPut(`/api/vendor-bills/${bill.id}`, { status })
      toast.success(`${bill.name} ${label}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? `${label} failed` : `${label}失败`))
    } finally {
      setBusy(false)
    }
  }

  // 全额付清也走这里（同销售发票）：记一笔金额 = 未付余额的流水，带上所选付款方式；
  // 不再用 PUT status=PAID——那条路径记的付款方式是「其他」、备注是占位文字
  async function registerPayment(amount: number) {
    if (!bill) return
    const add = amount
    if (!Number.isFinite(add) || add <= 0) {
      toast.error(isEn ? 'Please enter a valid payment amount' : '请输入有效的付款金额')
      return
    }
    setBusy(true)
    try {
      // ⛔ 传的是**本笔金额**，累计由服务端加（台账 G2），两人同时付款不会互相覆盖
      await apiPost(`/api/vendor-bills/${bill.id}/payments`, { amount: add, method: payMethod, note: payNote || null })
      toast.success(isEn ? `Payment of €${add.toFixed(2)} recorded` : `已登记付款 €${add.toFixed(2)}`)
      setPayAmount('')
      setPayNote('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to record payment' : '登记付款失败'))
    } finally {
      setBusy(false)
    }
  }

  async function saveSupplierInvoiceRef() {
    if (!bill || refDraft == null) return
    setSavingRef(true)
    try {
      await apiPut(`/api/vendor-bills/${bill.id}`, { supplierInvoiceRef: refDraft.trim() })
      toast.success(isEn ? 'Reference saved' : '发票参考号已保存')
      // 服务端会截断超长值——清掉草稿，让输入框回到真正落库的值
      setRefDraft(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save' : '保存失败'))
    } finally {
      setSavingRef(false)
    }
  }

  if (notFound) {
    return (
      <div className="text-center py-20 text-gray-400">
        {isEn ? 'Bill not found or has been deleted' : '账单不存在或已删除'}
        <div className="mt-4">
          <Button variant="outline" onClick={backToList}>{isEn ? 'Back to list' : '返回列表'}</Button>
        </div>
      </div>
    )
  }
  if (!bill) return <div className="text-center py-20 text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>

  const refValue = refDraft ?? bill.supplierInvoiceRef ?? ''
  const refDirty = refValue.trim() !== (bill.supplierInvoiceRef ?? '')
  const recon = bill.purchaseOrder ? bill.reconciliation : undefined
  const amountDue = Number(bill.amountDue ?? 0)
  const fmtTime = (v?: string | null) => (v ? new Date(v).toLocaleString('en-GB') : '—')

  return (
    <div className="max-w-4xl mx-auto p-4">
      {/* 顶部操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={backToList} className="text-sm text-gray-500 hover:text-gray-700">
            {isEn ? '← Back to vendor bills' : '← 返回供应商账单'}
          </button>
          <h1 className="text-2xl font-bold text-gray-900 font-mono" data-testid="vb-name">{bill.name}</h1>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_COLOR[bill.status]}`} data-testid="vb-status">
            {STATUS_LABEL[bill.status]}
          </span>
        </div>
        <div className="flex gap-2">
          {(bill.status === 'DRAFT' || bill.status === 'POSTED') && (
            <Button variant="outline" disabled={busy} onClick={() => changeStatus('CANCELLED', isEn ? 'cancelled' : '已作废')}
              className="text-red-600 border-red-200">
              {isEn ? 'Cancel bill' : '作废账单'}
            </Button>
          )}
          {bill.status === 'DRAFT' && (
            <Button disabled={busy} onClick={() => changeStatus('POSTED', isEn ? 'posted' : '已入账')}
              style={{ background: PURPLE, borderColor: PURPLE }} className="text-white hover:opacity-90">
              {isEn ? 'Confirm posting' : '确认入账'}
            </Button>
          )}
          {bill.status === 'POSTED' && (
            <Button disabled={busy} onClick={() => (amountDue > 0 ? registerPayment(amountDue) : changeStatus('PAID', isEn ? 'paid in full' : '已全额付款'))}
              style={{ background: PURPLE, borderColor: PURPLE }} className="text-white hover:opacity-90">
              {isEn ? 'Pay in full' : '全额付清'}
            </Button>
          )}
        </div>
      </div>

      {/* 供应商信息 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Supplier' : '供应商'}</p>
            <p className="mt-1 font-semibold text-gray-900" data-testid="vb-supplier">{bill.supplierName ?? bill.supplierId}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Source PO' : '来源采购单'}</p>
            {bill.purchaseOrder ? (
              <Link href={`${prefix}/classic/operator/purchases/${bill.purchaseOrder.id}`}
                className="mt-1 inline-block font-mono text-sm hover:underline" style={{ color: PURPLE }}>
                {bill.purchaseOrder.name}
              </Link>
            ) : <p className="mt-1 text-gray-400 text-sm">{isEn ? 'Manual bill' : '手工账单'}</p>}
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Bill Date' : '账单日期'}</p>
            <p className="mt-1 text-gray-700">{formatDateOnly(bill.billDate)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Due Date' : '到期日'}</p>
            <p className="mt-1 text-gray-700">{formatDateOnly(bill.dueDate)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Created At' : '创建时间'}</p>
            <p className="mt-1 text-gray-700">{fmtTime(bill.createdAt)}</p>
          </div>
          {bill.postedAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Posted At' : '入账时间'}</p>
              <p className="mt-1 text-gray-700">{fmtTime(bill.postedAt)}</p>
            </div>
          )}
          {bill.paidAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Paid At' : '付清时间'}</p>
              <p className="mt-1 text-green-700 font-medium">{fmtTime(bill.paidAt)}</p>
            </div>
          )}
          {bill.currency && bill.currency !== 'EUR' && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Currency' : '原币'}</p>
              <p className="mt-1 text-gray-700">{bill.currency} @ {Number(bill.exchangeRate ?? 1)}</p>
            </div>
          )}
          {/* 供应商发票参考号：自动生成的账单这里是空的，财务对着供应商发票回填 */}
          <div className="col-span-2 md:col-span-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Supplier Invoice Ref.' : '供应商发票参考号'}</p>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={refValue}
                onChange={e => setRefDraft(e.target.value)}
                maxLength={SUPPLIER_INVOICE_REF_MAX_LEN}
                placeholder={isEn ? 'e.g. the number on the supplier’s own invoice' : '如：供应商发票上印的号'}
                className="flex-1 max-w-md border border-gray-300 rounded px-2 py-1.5 text-sm"
                data-testid="vb-ref-input"
              />
              <Button size="sm" variant="outline" disabled={savingRef || !refDirty} onClick={saveSupplierInvoiceRef}>
                {savingRef ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 账单明细 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-gray-200" style={{ background: '#f3eff5' }}>
          <h2 className="font-semibold text-gray-700">{isEn ? 'Bill Lines' : '账单明细'}</h2>
        </div>
        <table className="w-full text-sm" data-testid="vb-lines">
          <thead className="border-b border-gray-100">
            <tr className="text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2 font-medium">{isEn ? 'Product' : '商品'}</th>
              <th className="text-center px-4 py-2 font-medium">{isEn ? 'Qty' : '数量'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Unit Cost (ex. tax)' : '单价（税前）'}</th>
              <th className="text-center px-4 py-2 font-medium">{isEn ? 'Tax Rate' : '税率'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Subtotal (ex. tax)' : '税前小计'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Subtotal (incl. tax)' : '含税小计'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {bill.lines.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">{isEn ? 'No lines' : '没有明细行'}</td></tr>
            )}
            {bill.lines.map((l, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{l.productName}</td>
                <td className="px-4 py-3 text-center">{Number(l.qty)}</td>
                <td className="px-4 py-3 text-right">{money(l.unitCost)}</td>
                <td className="px-4 py-3 text-center text-gray-500">{(Number(l.taxRate || 0) * 100).toFixed(1)}%</td>
                <td className="px-4 py-3 text-right">{money(lineExTax(l))}</td>
                <td className="px-4 py-3 text-right font-medium">{money(lineIncTax(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 汇总 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>{isEn ? 'Subtotal (ex. tax)' : '税前小计'}</span><span>{money(bill.subtotalExTax)}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>{isEn ? 'Total VAT' : 'VAT 合计'}</span><span>{money(bill.totalTax)}</span>
          </div>
          <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-200 pt-2 mt-2">
            <span>{isEn ? 'Total (incl. tax)' : '含税总额'}</span><span data-testid="vb-total">{money(bill.totalIncTax)}</span>
          </div>
          {Number(bill.amountPaid ?? 0) > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>{isEn ? 'Paid' : '已付款'}</span><span>{money(bill.amountPaid)}</span>
            </div>
          )}
          {bill.status !== 'CANCELLED' && (
            <div className={`flex justify-between text-base font-bold ${amountDue > 0 ? 'text-orange-600' : 'text-green-600'}`}>
              <span>{isEn ? 'Amount Due' : '待付款'}</span><span data-testid="vb-due">{money(amountDue)}</span>
            </div>
          )}
        </div>
        {bill.notes && <p className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">{isEn ? 'Notes: ' : '备注：'}{bill.notes}</p>}
      </div>

      {/* 三单核销：账单量 vs 收货量（判定口径见 lib/vendor-bill-reconciliation.ts） */}
      {recon && recon.lines.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mt-4" data-testid="vb-reconciliation">
          <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between" style={{ background: '#f3eff5' }}>
            <h2 className="font-semibold text-gray-700">{isEn ? '3-Way Match (PO / Received / Billed)' : '三单核销（下单 / 收货 / 账单）'}</h2>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${MATCH_COLOR[recon.status]}`}>
              {MATCH_LABEL[recon.status][isEn ? 1 : 0]}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Product' : '商品'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Ordered' : '下单'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Received' : '收货'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Billed' : '账单'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Diff' : '差异'}</th>
                <th className="text-center px-4 py-2 font-medium">{isEn ? 'Status' : '状态'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recon.lines.map(l => (
                <tr key={l.productId || l.productName}>
                  <td className="px-4 py-2 text-gray-800">{l.productName}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{l.orderedQty}</td>
                  <td className="px-4 py-2 text-right">{l.receivedQty}</td>
                  <td className="px-4 py-2 text-right">{l.billedQty}</td>
                  <td className={`px-4 py-2 text-right ${l.diff === 0 ? 'text-gray-400' : 'font-medium'}`}>{l.diff > 0 ? `+${l.diff}` : l.diff}</td>
                  <td className="px-4 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${MATCH_COLOR[l.status]}`}>{MATCH_LABEL[l.status][isEn ? 1 : 0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 付款记录（台账 G2）：一张账单分几笔付、哪天付、谁付的 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mt-4">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between" style={{ background: '#f3eff5' }}>
          <h2 className="font-semibold text-gray-700">{isEn ? 'Payment History' : '付款记录'}</h2>
          <span className="text-xs text-gray-500">
            {isEn
              ? `Paid ${money(bill.amountPaid)} / Total ${money(bill.totalIncTax)}`
              : `已付 ${money(bill.amountPaid)} / 共 ${money(bill.totalIncTax)}`}
          </span>
        </div>
        {payments.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">{isEn ? 'No payment records yet' : '暂无付款流水'}</div>
        ) : (
          <table className="w-full text-sm" data-testid="vb-payments">
            <thead className="border-b border-gray-100">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Paid On' : '付款日期'}</th>
                <th className="text-center px-4 py-2 font-medium">{isEn ? 'Method' : '方式'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Amount' : '金额'}</th>
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Note' : '备注'}</th>
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Handled By' : '经办人'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 text-gray-700">{formatDateOnly(p.paidAt)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${p.method === 'cash' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                      {VENDOR_PAYMENT_METHOD_LABELS[p.method as keyof typeof VENDOR_PAYMENT_METHOD_LABELS]?.[isEn ? 'en' : 'zh'] ?? p.method}
                    </span>
                  </td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${Number(p.amount) < 0 ? 'text-gray-500' : 'text-green-700'}`}>{money(p.amount)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{p.note ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{p.createdBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {bill.status === 'POSTED' && amountDue > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 bg-amber-50 flex flex-wrap items-center gap-2">
            <span className="text-xs text-amber-700">{isEn ? 'Record a payment €' : '记一笔付款 €'}</span>
            <input
              type="number" min="0.01" step="0.01"
              value={payAmount}
              onChange={e => setPayAmount(e.target.value)}
              placeholder={amountDue.toFixed(2)}
              className="w-28 border border-amber-300 rounded px-2 py-1 text-sm"
              data-testid="vb-pay-amount"
            />
            <select value={payMethod} onChange={e => setPayMethod(e.target.value)}
              className="border border-amber-300 rounded px-2 py-1 text-sm bg-white">
              {VENDOR_PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>{VENDOR_PAYMENT_METHOD_LABELS[m][isEn ? 'en' : 'zh']}</option>
              ))}
            </select>
            <input
              value={payNote}
              onChange={e => setPayNote(e.target.value)}
              placeholder={isEn ? 'Note (e.g. bank ref)' : '备注（如银行流水号）'}
              className="flex-1 min-w-32 border border-amber-300 rounded px-2 py-1 text-sm"
            />
            <Button size="sm" disabled={busy} onClick={() => registerPayment(Number(payAmount))} data-testid="vb-pay-submit">{isEn ? 'Record' : '登记'}</Button>
            <span className="text-[11px] text-amber-600">{isEn ? 'Auto-marks as "Paid" once fully settled' : '付清后自动转「已付款」'}</span>
          </div>
        )}
      </div>

      <ActionLogPanel key={logKey} resource="vendor_bill" resourceId={bill.id} />
    </div>
  )
}
