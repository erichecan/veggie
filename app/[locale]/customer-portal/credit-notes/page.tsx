'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

type Credit = { id: string; name: string; creditDate: string; status: string; amount: number; applied: number; remaining: number }

export default function CustomerCreditsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [items, setItems] = useState<Credit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setItems((await apiGet<{ items: Credit[] }>('/api/customer-portal/credit-notes')).items ?? []) }
    catch { setError(isEn ? 'Could not load credit notes.' : '暂时无法加载 credit。') }
    finally { setLoading(false) }
  }, [isEn])
  useEffect(() => { void load() }, [load])
  const totals = items.reduce((acc, item) => ({ amount: acc.amount + Number(item.amount), applied: acc.applied + Number(item.applied), remaining: acc.remaining + Number(item.remaining) }), { amount: 0, applied: 0, remaining: 0 })

  return <div className="mx-auto max-w-5xl space-y-4">
    <h1 className="text-xl font-bold text-[#356b2f]">{isEn ? 'My Credits' : '我的 Credit'}</h1>
    <p className="text-sm text-gray-600">{isEn ? 'Credits are applied to your invoices by the accounts team. No payment is made to your account unless a refund is recorded.' : 'Credit 通常由会计用于抵扣您的发票；只有登记退款时才会支付给您。'}</p>
    {loading ? <p className="py-10 text-center text-gray-500">{isEn ? 'Loading…' : '加载中…'}</p> : error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}<button onClick={() => void load()} className="ml-3 underline">{isEn ? 'Retry' : '重试'}</button></div> : items.length === 0 ? <p className="rounded-xl border bg-white p-8 text-center text-sm text-gray-500">{isEn ? 'No available credit notes.' : '暂无可用的 Credit。'}</p> : <div className="overflow-x-auto rounded-xl border border-[#dce7d9] bg-white"><table className="w-full text-sm"><thead className="bg-green-50 text-left text-xs text-gray-600"><tr><th className="px-4 py-3">{isEn ? 'Credit note' : 'Credit 单号'}</th><th className="px-4 py-3">{isEn ? 'Date' : '日期'}</th><th className="px-4 py-3">{isEn ? 'Status' : '状态'}</th><th className="px-4 py-3 text-right">{isEn ? 'Amount' : '金额'}</th><th className="px-4 py-3 text-right">{isEn ? 'Applied' : '已抵扣'}</th><th className="px-4 py-3 text-right">{isEn ? 'Available' : '可用余额'}</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-t"><td className="px-4 py-3 font-medium">{item.name}</td><td className="px-4 py-3">{formatDateOnly(item.creditDate)}</td><td className="px-4 py-3">{item.status === 'SETTLED' ? (isEn ? 'Paid / settled' : '已退款/结清') : (isEn ? 'Available' : '可抵扣')}</td><td className="px-4 py-3 text-right">€{Number(item.amount).toFixed(2)}</td><td className="px-4 py-3 text-right">€{Number(item.applied).toFixed(2)}</td><td className="px-4 py-3 text-right font-semibold text-[#356b2f]">€{Number(item.remaining).toFixed(2)}</td></tr>)}</tbody><tfoot className="border-t bg-gray-50 font-semibold"><tr><td className="px-4 py-3" colSpan={3}>{isEn ? 'Total' : '合计'}</td><td className="px-4 py-3 text-right">€{totals.amount.toFixed(2)}</td><td className="px-4 py-3 text-right">€{totals.applied.toFixed(2)}</td><td className="px-4 py-3 text-right">€{totals.remaining.toFixed(2)}</td></tr></tfoot></table></div>}
  </div>
}
