'use client'
/**
 * 贷记单「去向」区块 —— 20261014（复式改造 L1）
 * 抵扣发票 / 退款 / 撤销。规则在 lib/finance/credit-note-allocation.ts，这里只是界面。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { hasPermission, useAbility } from '@/lib/permissions'

interface Allocation {
  id: string
  kind: 'INVOICE' | 'REFUND'
  amount: number | string
  method?: string | null
  invoice?: { id: string; name: string } | null
  reversalOfId?: string | null
  reversed?: boolean
  note?: string | null
  createdBy?: string | null
  createdAt: string
}

interface InvoiceSuggestion {
  id: string
  name: string
  amountDue: number | string
  totalIncTax: number | string
  dueDate?: string | null
  matchesSourceOrder: boolean
}

interface CreditNoteDetail {
  id: string
  name: string
  status: string
  totalIncTax: number | string
  amountAllocated: number
  amountRemaining: number
  allocations: Allocation[]
  invoiceSuggestions: InvoiceSuggestion[]
}

const eur = (v: unknown) => `€${Number(v ?? 0).toFixed(2)}`

export default function CreditNoteAllocations({ creditNoteId, isEn, onChanged }: {
  creditNoteId: string
  isEn: boolean
  onChanged?: () => void
}) {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const ability = useAbility()
  const canEdit = hasPermission(ability, 'finance.credit_note.update')
  const [data, setData] = useState<CreditNoteDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [refundAmount, setRefundAmount] = useState('')
  const [refundMethod, setRefundMethod] = useState('transfer')

  const load = useCallback(() => {
    apiGet<CreditNoteDetail>(`/api/credit-notes/${creditNoteId}`)
      .then(d => { setData(d); setRefundAmount(d.amountRemaining > 0 ? d.amountRemaining.toFixed(2) : '') })
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
  }, [creditNoteId, isEn])

  useEffect(() => { load() }, [load])

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      load()
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  if (!data) return null
  if (!['CONFIRMED', 'SETTLED'].includes(data.status) && data.allocations.length === 0) return null

  const remaining = data.amountRemaining
  const usable = canEdit && ['CONFIRMED', 'SETTLED'].includes(data.status) && remaining > 0.005

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3" data-testid="cn-allocations">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-800">{isEn ? 'Applied / Refunded' : '抵扣与退款'}</span>
        <span className="text-xs text-gray-600">
          {isEn ? 'Used' : '已用'} <b>{eur(data.amountAllocated)}</b> · {isEn ? 'Remaining' : '剩余'}{' '}
          <b className={remaining > 0.005 ? 'text-blue-700' : 'text-green-700'}>{eur(remaining)}</b>
        </span>
      </div>

      {data.allocations.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left py-1">{isEn ? 'Date' : '日期'}</th>
              <th className="text-left py-1">{isEn ? 'Type' : '类型'}</th>
              <th className="text-left py-1">{isEn ? 'Invoice / Method' : '发票 / 方式'}</th>
              <th className="text-right py-1">{isEn ? 'Amount' : '金额'}</th>
              <th className="text-left py-1 pl-3">{isEn ? 'By' : '经手'}</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.allocations.map(a => {
              const neg = Number(a.amount) < 0
              return (
                <tr key={a.id} className={neg || a.reversed ? 'text-gray-400' : ''}>
                  <td className="py-1">{new Date(a.createdAt).toLocaleDateString('en-GB')}</td>
                  <td className="py-1">
                    {neg ? (isEn ? 'Reversal' : '撤销') : a.kind === 'REFUND' ? (isEn ? 'Refund' : '退款') : (isEn ? 'Applied to invoice' : '抵扣发票')}
                  </td>
                  <td className="py-1">
                    {a.invoice
                      ? <a className="text-[#714B67] hover:underline" href={`${prefix}/classic/finance/invoices/${a.invoice.id}`}>{a.invoice.name}</a>
                      : a.method ?? '—'}
                  </td>
                  <td className="py-1 text-right font-medium">{eur(a.amount)}</td>
                  <td className="py-1 pl-3">{a.createdBy ?? '—'}</td>
                  <td className="py-1 text-right">
                    {canEdit && !neg && !a.reversed && (
                      <button
                        className="text-red-600 hover:underline disabled:opacity-50"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(isEn ? 'Reverse this entry?' : '撤销这条记录？（会追加一条冲正记录，原记录保留）')) return
                          run(() => apiPost(`/api/credit-notes/${data.id}/allocations/${a.id}/reverse`, {}), isEn ? 'Reversed' : '已撤销')
                        }}
                      >
                        {isEn ? 'Reverse' : '撤销'}
                      </button>
                    )}
                    {a.reversed && <span>{isEn ? 'reversed' : '已撤销'}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {usable && (
        <>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">{isEn ? 'Apply to an open invoice' : '抵扣未付发票'}</div>
            {data.invoiceSuggestions.length === 0 ? (
              <p className="text-xs text-gray-400">{isEn ? 'This customer has no open posted invoices.' : '该客户没有已过账的未付发票。'}</p>
            ) : (
              <table className="w-full text-xs">
                <tbody className="divide-y divide-gray-100">
                  {data.invoiceSuggestions.map(inv => {
                    const def = Math.min(remaining, Number(inv.amountDue)).toFixed(2)
                    return (
                      <tr key={inv.id}>
                        <td className="py-1">
                          <span className="font-mono">{inv.name}</span>
                          {inv.matchesSourceOrder && (
                            <span className="ml-2 px-1.5 rounded bg-amber-100 text-amber-800">{isEn ? 'same order' : '来源订单'}</span>
                          )}
                        </td>
                        <td className="py-1 text-gray-500">{isEn ? 'Due' : '未付'} {eur(inv.amountDue)}</td>
                        <td className="py-1 text-right">
                          <input
                            type="number" step="0.01" min="0"
                            className="w-24 border border-gray-300 rounded px-1 py-0.5 text-right"
                            value={amounts[inv.id] ?? def}
                            onChange={e => setAmounts(m => ({ ...m, [inv.id]: e.target.value }))}
                          />
                        </td>
                        <td className="py-1 pl-2 text-right">
                          <Button
                            size="sm" disabled={busy}
                            onClick={() => run(
                              () => apiPost(`/api/credit-notes/${data.id}/allocations`, { kind: 'INVOICE', invoiceId: inv.id, amount: Number(amounts[inv.id] ?? def) }),
                              isEn ? `Applied to ${inv.name}` : `已抵扣 ${inv.name}`,
                            )}
                          >
                            {isEn ? 'Apply' : '抵扣'}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-gray-600">{isEn ? 'Refund to customer' : '退款给客户'}</span>
            <input
              type="number" step="0.01" min="0"
              className="w-24 border border-gray-300 rounded px-1 py-0.5 text-right"
              value={refundAmount}
              onChange={e => setRefundAmount(e.target.value)}
            />
            <select className="border border-gray-300 rounded px-1 py-0.5" value={refundMethod} onChange={e => setRefundMethod(e.target.value)}>
              <option value="transfer">{isEn ? 'Bank transfer' : '转账'}</option>
              <option value="cash">{isEn ? 'Cash' : '现金'}</option>
              <option value="other">{isEn ? 'Other' : '其他'}</option>
            </select>
            <Button
              size="sm" variant="outline" disabled={busy || !(Number(refundAmount) > 0)}
              onClick={() => {
                if (!window.confirm(isEn ? `Record refund of €${Number(refundAmount).toFixed(2)}?` : `确认已退款 €${Number(refundAmount).toFixed(2)} 给客户？会生成银行付款凭证`)) return
                run(
                  () => apiPost(`/api/credit-notes/${data.id}/allocations`, { kind: 'REFUND', amount: Number(refundAmount), method: refundMethod }),
                  isEn ? 'Refund recorded' : '已登记退款',
                )
              }}
            >
              {isEn ? 'Record refund' : '登记退款'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
