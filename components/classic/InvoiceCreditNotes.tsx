'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { hasPermission, useAbility } from '@/lib/permissions'

interface AvailableCreditNote {
  id: string
  name: string
  status: string
  customerId: string
  customerName: string
  totalIncTax: number | string
  amountRemaining: number | string
  sourceInvoice?: { id: string; name: string } | null
  creditDate: string
}

const euro = (value: unknown) => `€${Number(value ?? 0).toFixed(2)}`

export default function InvoiceCreditNotes({
  invoiceId,
  customerId,
  amountDue,
  isEn,
  onApplied,
}: {
  invoiceId: string
  customerId: string
  amountDue: number
  isEn: boolean
  onApplied: () => void | Promise<void>
}) {
  const ability = useAbility()
  const canApply = hasPermission(ability, 'finance.credit_note.update')
  const [creditNotes, setCreditNotes] = useState<AvailableCreditNote[]>([])
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await apiGet<AvailableCreditNote[]>(`/api/credit-notes?customerId=${encodeURIComponent(customerId)}&status=CONFIRMED`)
      const available = rows.filter(row => Number(row.amountRemaining) > 0.005)
      setCreditNotes(available)
      setAmounts(previous => {
        const next = { ...previous }
        for (const row of available) {
          const maxAmount = Math.min(Number(row.amountRemaining), amountDue)
          const currentAmount = Number(next[row.id])
          if (!next[row.id] || !Number.isFinite(currentAmount) || currentAmount > maxAmount) {
            next[row.id] = maxAmount.toFixed(2)
          }
        }
        return next
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Could not load available credit notes' : '加载可用贷记单失败'))
    } finally {
      setLoading(false)
    }
  }, [customerId, amountDue, isEn])

  useEffect(() => { void load() }, [load])

  async function apply(creditNote: AvailableCreditNote) {
    const amount = Number(amounts[creditNote.id] ?? Math.min(Number(creditNote.amountRemaining), amountDue))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(isEn ? 'Enter an amount greater than zero' : '请输入大于 0 的抵扣金额')
      return
    }
    setBusyId(creditNote.id)
    try {
      await apiPost(`/api/credit-notes/${creditNote.id}/allocations`, {
        kind: 'INVOICE', invoiceId, amount,
      })
      toast.success(isEn ? `${euro(amount)} credit applied to this invoice` : `已抵扣本发票 ${euro(amount)}`)
      await load()
      await onApplied()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Credit application failed' : '贷记单抵扣失败'))
    } finally {
      setBusyId('')
    }
  }

  if (!canApply) return null

  return (
    <section className="mt-4 rounded-xl border border-blue-200 bg-blue-50/40 p-5" data-testid="invoice-available-credit-notes">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-gray-800">{isEn ? 'Available customer credit' : '客户可用贷记单'}</h2>
        <span className="text-xs text-gray-500">
          {isEn ? `Invoice balance due: ${euro(amountDue)}` : `本发票待收：${euro(amountDue)}`}
        </span>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">{isEn ? 'Loading…' : '加载中…'}</p>
      ) : creditNotes.length === 0 ? (
        <p className="text-sm text-gray-500">{isEn ? 'No confirmed unused credit notes for this customer.' : '该客户没有已确认且尚未使用的贷记单。'}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-blue-100 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">{isEn ? 'Credit note' : '贷记单号'}</th>
                <th className="px-3 py-2 text-left">{isEn ? 'Date' : '日期'}</th>
                <th className="px-3 py-2 text-right">{isEn ? 'Available' : '可用余额'}</th>
                <th className="px-3 py-2 text-right">{isEn ? 'Apply amount' : '本次抵扣金额'}</th>
                <th className="px-3 py-2 text-right">{isEn ? 'Action' : '操作'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {creditNotes.map(creditNote => {
                const maxAmount = Math.min(Number(creditNote.amountRemaining), amountDue)
                return (
                  <tr key={creditNote.id}>
                    <td className="px-3 py-2 font-mono font-medium text-gray-800">{creditNote.name}</td>
                    <td className="px-3 py-2 text-gray-600">{new Date(creditNote.creditDate).toLocaleDateString('en-GB')}</td>
                    <td className="px-3 py-2 text-right font-medium text-blue-700">{euro(creditNote.amountRemaining)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        aria-label={isEn ? `Apply amount for ${creditNote.name}` : `${creditNote.name} 抵扣金额`}
                        type="number" min="0.01" max={maxAmount} step="0.01"
                        className="w-28 rounded border border-gray-300 px-2 py-1 text-right"
                        value={amounts[creditNote.id] ?? maxAmount.toFixed(2)}
                        onChange={event => setAmounts(current => ({ ...current, [creditNote.id]: event.target.value }))}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" disabled={Boolean(busyId) || maxAmount <= 0} onClick={() => void apply(creditNote)}>
                        {busyId === creditNote.id ? (isEn ? 'Applying…' : '抵扣中…') : (isEn ? 'Apply' : '抵扣')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">
        {isEn
          ? 'Applying credit reduces the amount due; it does not record a cash or bank payment.'
          : '抵扣会减少发票待收金额，不会登记现金或银行收款。'}
      </p>
    </section>
  )
}
