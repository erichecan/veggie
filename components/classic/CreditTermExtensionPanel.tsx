'use client'
/**
 * 账期临时延期面板（20260826）
 * ============================================================================
 * 客户详情页用：展示当前欠款/逾期/延期状态，持有 `master.customer.extend_term`
 * 权限的人（会计/主管）能在这里给逾期客户批 +1周/+2周/自定义天数 的延期，
 * 延期期间该客户所有订单不因逾期/信用额度超限被拦，但欠款数字照样如实显示。
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { hasPermission, useAbility } from '@/lib/permissions'

interface CreditInfo {
  outstandingBalance: number
  overdueAmount: number
  creditLimit: number
  canOrder: boolean
  blockReason?: string
  isTermExtended: boolean
  termExtendedUntil: string | null
  termExtendedNote: string | null
}

export default function CreditTermExtensionPanel({ customerId, isEn }: { customerId: string; isEn: boolean }) {
  const ability = useAbility()
  const canExtend = hasPermission(ability, 'master.customer.extend_term')
  const [info, setInfo] = useState<CreditInfo | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [customDays, setCustomDays] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function load() {
    apiGet<CreditInfo>(`/api/customers/${customerId}/credit`).then(setInfo).catch(() => {})
  }
  useEffect(load, [customerId])

  async function extend(days: number) {
    if (!Number.isFinite(days) || days < 1) {
      toast.error(isEn ? 'Enter a valid number of days' : '请输入有效的天数')
      return
    }
    setSubmitting(true)
    try {
      await apiPost(`/api/customers/${customerId}/term-extension`, { days, note: note.trim() || undefined })
      toast.success(isEn ? `Term extended by ${days} day(s)` : `账期已延长 ${days} 天`)
      setShowForm(false)
      setCustomDays('')
      setNote('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to extend term' : '延长账期失败'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!info) return <p className="text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-600 space-x-3">
        <span>{isEn ? 'Outstanding' : '欠款'} €{info.outstandingBalance.toFixed(2)}</span>
        {info.overdueAmount > 0 && (
          <span className="text-rose-600">{isEn ? 'Overdue' : '逾期'} €{info.overdueAmount.toFixed(2)}</span>
        )}
        {!info.canOrder && (
          <span className="text-rose-600 font-medium">⛔ {isEn ? 'Credit frozen' : '信用冻结'}</span>
        )}
      </div>

      {info.isTermExtended && info.termExtendedUntil && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {isEn ? 'Temporarily extended until' : '账期已临时延长至'} {new Date(info.termExtendedUntil).toLocaleDateString('en-CA')}
          {info.termExtendedNote ? `（${info.termExtendedNote}）` : ''}
        </p>
      )}

      {canExtend && (
        showForm ? (
          <div className="border border-gray-200 rounded p-2 space-y-2">
            <div className="flex gap-2">
              <button type="button" disabled={submitting} onClick={() => extend(7)}
                className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50">
                +1{isEn ? ' week' : '周'}
              </button>
              <button type="button" disabled={submitting} onClick={() => extend(14)}
                className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50">
                +2{isEn ? ' weeks' : '周'}
              </button>
              <input
                type="number" min={1} max={365} value={customDays}
                onChange={e => setCustomDays(e.target.value)}
                placeholder={isEn ? 'Custom days' : '自定义天数'}
                className="w-24 px-2 py-1 text-xs border border-gray-300 rounded"
              />
              <button type="button" disabled={submitting || !customDays} onClick={() => extend(Number(customDays))}
                className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">
                {isEn ? 'Extend' : '确认延期'}
              </button>
            </div>
            <input
              type="text" value={note} onChange={e => setNote(e.target.value)}
              placeholder={isEn ? 'Note (e.g. customer promised to settle next week)' : '备注（如：客户答应下周结清）'}
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded"
            />
            <button type="button" onClick={() => setShowForm(false)} className="text-xs text-gray-400 hover:text-gray-600">
              {isEn ? 'Cancel' : '取消'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setShowForm(true)}
            className="px-2 py-1 text-xs rounded text-white" style={{ background: '#875A7B' }}>
            {isEn ? 'Extend Term' : '延长账期'}
          </button>
        )
      )}
    </div>
  )
}
