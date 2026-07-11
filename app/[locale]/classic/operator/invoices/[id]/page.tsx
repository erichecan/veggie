'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import type { Invoice } from '@/lib/types'
import { Button } from '@/components/ui/button'
import ActionLogPanel from '@/components/shared/action-log-panel'
import Link from 'next/link'

const PURPLE = '#875A7B'

interface PaymentRow {
  id: string
  amount: number
  method: string
  paidAt: string
  note?: string | null
  createdBy?: string | null
}

const METHOD_LABEL_ZH: Record<string, string> = { cash: '现金', transfer: '转账', other: '其他' }
const METHOD_LABEL_EN: Record<string, string> = { cash: 'Cash', transfer: 'Transfer', other: 'Other' }

const STATUS_LABEL_ZH: Record<Invoice['status'], string> = {
  draft: '草稿',
  posted: '已确认',
  paid: '已付款',
  cancelled: '已取消',
}

const STATUS_LABEL_EN: Record<Invoice['status'], string> = {
  draft: 'Draft',
  posted: 'Posted',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

const STATUS_COLOR: Record<Invoice['status'], string> = {
  draft: 'bg-gray-100 text-gray-700',
  posted: 'bg-purple-100 text-purple-700',
  paid: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

export default function ClassicInvoiceDetailPage() {
  const params = useParams()
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const METHOD_LABEL = isEn ? METHOD_LABEL_EN : METHOD_LABEL_ZH
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const [inv, setInv] = useState<Invoice | null>(null)
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('transfer')
  const [payNote, setPayNote] = useState('')
  const [payBusy, setPayBusy] = useState(false)

  async function load() {
    try {
      const found = await apiGet<Invoice>(`/api/invoices/${params.id}`)
      if (!found) { setInv(null); return }
      setInv({ ...found, status: found.status?.toLowerCase() as Invoice['status'] ?? found.status })
      apiGet<PaymentRow[]>(`/api/payments?invoiceId=${params.id}`)
        .then(setPayments)
        .catch(() => {})
    } catch {
      setInv(null)
    }
  }

  useEffect(() => { load() }, [params.id])

  async function addPayment(amount: number) {
    if (!inv) return
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(isEn ? 'Please enter a valid payment amount' : '请输入有效的收款金额')
      return
    }
    setPayBusy(true)
    try {
      await apiPost('/api/payments', {
        invoiceId: inv.id, amount, method: payMethod, note: payNote || undefined,
      })
      toast.success(isEn ? `Payment of €${amount.toFixed(2)} recorded` : `已登记收款 €${amount.toFixed(2)}`)
      setPayAmount(''); setPayNote('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed to record payment' : '登记收款失败'))
    } finally {
      setPayBusy(false)
    }
  }

  async function handlePost() {
    if (!inv) return
    try {
      // 走专用过账接口:生成会计凭证 + 回写 invoicedQty(不能用 PUT 直接改状态绕过)
      const res = await apiPost<{ warning?: string }>(`/api/invoices/${inv.id}/post`, {})
      setInv({ ...inv, status: 'posted', postedAt: new Date().toISOString() })
      toast.success(res?.warning
        ? (isEn ? `Posted, but ${res.warning}` : `已确认,但${res.warning}`)
        : (isEn ? 'Invoice posted' : '发票已确认（Posted）'))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Operation failed' : '操作失败'))
    }
  }

  // 全额收款:走 payments API 留分笔流水,付清后服务端自动转 PAID
  async function handlePay() {
    if (!inv) return
    await addPayment(inv.amountDue)
  }

  async function handleCancel() {
    if (!inv) return
    if (!confirm(isEn ? 'Confirm cancelling this invoice?' : '确认取消此发票？')) return
    const updated: Invoice = { ...inv, status: 'cancelled' }
    try {
      await apiPut(`/api/invoices/${inv.id}`, { ...updated, status: 'cancelled' })
      setInv(updated)
      toast.success(isEn ? 'Invoice cancelled' : '发票已取消')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Operation failed' : '操作失败'))
    }
  }

  if (!inv) {
    return (
      <div className="text-center py-20 text-gray-400">
        {isEn ? 'Invoice not found or has been deleted' : '发票不存在或已删除'}
        <div className="mt-4">
          <Button variant="outline" onClick={() => router.push(`${prefix}/classic/operator/invoices`)}>
            {isEn ? 'Back to list' : '返回列表'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/invoices`)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            {isEn ? '← Back to invoices' : '← 返回发票列表'}
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{inv.name}</h1>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_COLOR[inv.status]}`}>
            {STATUS_LABEL[inv.status]}
          </span>
        </div>
        <div className="flex gap-2">
          <Link
            href={`${prefix}/classic/operator/invoices/${inv.id}/print`}
            target="_blank"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            {isEn ? '↓ Download PDF' : '↓ 下载 PDF'}
          </Link>
          {inv.status === 'draft' && (
            <>
              <Button variant="outline" onClick={handleCancel} className="text-red-600 border-red-200">
                {isEn ? 'Cancel invoice' : '取消发票'}
              </Button>
              <Button
                onClick={handlePost}
                style={{ background: PURPLE, borderColor: PURPLE }}
                className="text-white hover:opacity-90"
              >
                {isEn ? 'Post invoice' : '确认发票'}
              </Button>
            </>
          )}
          {inv.status === 'posted' && (
            <Button
              onClick={handlePay}
              disabled={payBusy}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="text-white hover:opacity-90"
            >
              {isEn ? 'Pay in full' : '全额收款'}
            </Button>
          )}
        </div>
      </div>

      {/* 客户信息 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Customer' : '客户'}</p>
            <p className="mt-1 font-semibold text-gray-900">{inv.customerName}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Payment Terms' : '结款方式'}</p>
            <p className="mt-1 font-medium text-gray-800">
              {(isEn
                ? { cash: 'Cash on delivery', weekly: 'Weekly', monthly: 'Monthly' }
                : { cash: '现付', weekly: '周结', monthly: '月结' })[inv.paymentTerms]}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Created At' : '创建时间'}</p>
            <p className="mt-1 text-gray-700">{new Date(inv.createdAt).toLocaleString('en-GB')}</p>
          </div>
          {inv.postedAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Posted At' : '确认时间'}</p>
              <p className="mt-1 text-gray-700">{new Date(inv.postedAt).toLocaleString('en-GB')}</p>
            </div>
          )}
          {inv.paidAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Paid At' : '付款时间'}</p>
              <p className="mt-1 text-green-700 font-medium">{new Date(inv.paidAt).toLocaleString('en-GB')}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{isEn ? 'Related Orders' : '关联订单'}</p>
            <p className="mt-1 text-gray-600 text-sm">{isEn ? `${inv.saleOrderIds.length} order(s)` : `${inv.saleOrderIds.length} 个订单`}</p>
          </div>
        </div>
      </div>

      {/* 发票明细 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-gray-200" style={{ background: '#f3eff5' }}>
          <h2 className="font-semibold text-gray-700">{isEn ? 'Invoice Lines' : '发票明细'}</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100">
            <tr className="text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2 font-medium">{isEn ? 'Product' : '商品'}</th>
              <th className="text-center px-4 py-2 font-medium">{isEn ? 'Qty' : '数量'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Unit Price (incl. tax)' : '单价（含税）'}</th>
              <th className="text-center px-4 py-2 font-medium">{isEn ? 'Tax Rate' : '税率'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Subtotal (ex. tax)' : '税前小计'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Tax Amount' : '税额'}</th>
              <th className="text-right px-4 py-2 font-medium">{isEn ? 'Subtotal (incl. tax)' : '含税小计'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(inv.lines ?? []).map((line, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-800">{line.productName}</p>
                  <p className="text-xs text-gray-400">{line.spec}</p>
                </td>
                <td className="px-4 py-3 text-center">{Number(line.qty ?? 0)}</td>
                <td className="px-4 py-3 text-right">€{Number(line.unitPrice ?? 0).toFixed(2)}</td>
                <td className="px-4 py-3 text-center text-gray-500">{(Number(line.taxRate ?? 0) * 100).toFixed(1)}%</td>
                <td className="px-4 py-3 text-right">€{Number(line.subtotalExTax ?? 0).toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-500">€{Number(line.taxAmount ?? 0).toFixed(2)}</td>
                <td className="px-4 py-3 text-right font-medium">€{Number(line.subtotalIncTax ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 汇总 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>{isEn ? 'Subtotal (ex. tax)' : '税前小计'}</span>
            <span>€{Number(inv.subtotalExTax ?? 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>{isEn ? 'Total VAT' : 'VAT 合计'}</span>
            <span>€{Number(inv.totalTax ?? 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-200 pt-2 mt-2">
            <span>{isEn ? 'Total (incl. tax)' : '含税总额'}</span>
            <span>€{Number(inv.totalIncTax ?? 0).toFixed(2)}</span>
          </div>
          {Number(inv.amountPaid ?? 0) > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>{isEn ? 'Paid' : '已付款'}</span>
              <span>€{Number(inv.amountPaid ?? 0).toFixed(2)}</span>
            </div>
          )}
          <div className={`flex justify-between text-base font-bold ${Number(inv.amountDue ?? 0) > 0 ? 'text-orange-600' : 'text-green-600'}`}>
            <span>{isEn ? 'Amount Due' : '待收款'}</span>
            <span>€{Number(inv.amountDue ?? 0).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* 收款记录 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mt-4">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between" style={{ background: '#f3eff5' }}>
          <h2 className="font-semibold text-gray-700">{isEn ? 'Payment History' : '收款记录'}</h2>
          <span className="text-xs text-gray-500">
            {isEn
              ? `Received €${inv.amountPaid.toFixed(2)} / Total €${inv.totalIncTax.toFixed(2)}`
              : `已收 €${inv.amountPaid.toFixed(2)} / 共 €${inv.totalIncTax.toFixed(2)}`}
          </span>
        </div>

        {payments.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">{isEn ? 'No payment records yet' : '暂无收款流水'}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Paid At' : '收款时间'}</th>
                <th className="text-center px-4 py-2 font-medium">{isEn ? 'Method' : '方式'}</th>
                <th className="text-right px-4 py-2 font-medium">{isEn ? 'Amount' : '金额'}</th>
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Note' : '备注'}</th>
                <th className="text-left px-4 py-2 font-medium">{isEn ? 'Handled By' : '经办人'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 text-gray-700">{new Date(p.paidAt).toLocaleString('en-GB')}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.method === 'cash' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {METHOD_LABEL[p.method] ?? p.method}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-green-700">€{Number(p.amount).toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{p.note ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{p.createdBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {inv.status === 'posted' && inv.amountDue > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 bg-amber-50 flex flex-wrap items-center gap-2">
            <span className="text-xs text-amber-700">{isEn ? 'Record a payment €' : '记一笔收款 €'}</span>
            <input
              type="number" min="0.01" step="0.01"
              value={payAmount}
              onChange={e => setPayAmount(e.target.value)}
              placeholder={inv.amountDue.toFixed(2)}
              className="w-28 border border-amber-300 rounded px-2 py-1 text-sm"
            />
            <select
              value={payMethod}
              onChange={e => setPayMethod(e.target.value)}
              className="border border-amber-300 rounded px-2 py-1 text-sm bg-white"
            >
              <option value="transfer">{isEn ? 'Transfer' : '转账'}</option>
              <option value="cash">{isEn ? 'Cash' : '现金'}</option>
              <option value="other">{isEn ? 'Other' : '其他'}</option>
            </select>
            <input
              value={payNote}
              onChange={e => setPayNote(e.target.value)}
              placeholder={isEn ? 'Note (optional)' : '备注(可选)'}
              className="flex-1 min-w-32 border border-amber-300 rounded px-2 py-1 text-sm"
            />
            <Button size="sm" disabled={payBusy} onClick={() => addPayment(Number(payAmount))}>{isEn ? 'Record' : '登记'}</Button>
            <span className="text-[11px] text-amber-600">{isEn ? 'Auto-marks as "Paid" once fully settled' : '付清后自动转「已付款」'}</span>
          </div>
        )}
      </div>

      {/* Demo 提示 */}
      <div className="mt-4 p-3 rounded-lg text-xs border bg-purple-50 border-purple-100 text-purple-700">
        <strong>{isEn ? 'Demo: ' : 'Demo 演示：'}</strong>
        {isEn
          ? 'Draft → click "Post invoice" → record payments individually or use "Pay in full"; auto-marks as Paid once fully settled.'
          : '草稿 → 点击「确认发票」→ 分笔登记收款或「全额收款」，付清自动转已付款。'}
      </div>
      <ActionLogPanel resource="invoice" resourceId={String(params.id)} />
    </div>
  )
}
