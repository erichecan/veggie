'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

type Statement = { id: string; customerName: string; periodStart: string; periodEnd: string; openingBalance: number; totalSales: number; totalPayments: number; totalCredits: number; closingBalance: number; sentAt: string | null }
type StatementDetail = Omit<Statement, 'sentAt'> & { orders: Array<{ id: string; code: string | null; deliveryDate: string | null; amount: number }>; payments: Array<{ id: string; date: string; method: string; invoiceName: string | null; amount: number }>; credits: Array<{ id: string; name: string; date: string; amount: number }> }

export default function CustomerStatementsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [items, setItems] = useState<Statement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [details, setDetails] = useState<Record<string, StatementDetail>>({})
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setItems((await apiGet<{ items: Statement[] }>('/api/customer-portal/statements')).items ?? []) }
    catch { setError(isEn ? 'Could not load statements.' : '暂时无法加载对账单。') }
    finally { setLoading(false) }
  }, [isEn])
  useEffect(() => { void load() }, [load])
  async function toggleDetails(id: string) {
    const next = new Set(openIds)
    if (next.has(id)) { next.delete(id); setOpenIds(next); return }
    setOpenIds(next.add(id))
    if (!details[id]) {
      try {
        const detail = await apiGet<StatementDetail>(`/api/customer-portal/statements/${id}`)
        setDetails(current => ({ ...current, [id]: detail }))
      }
      catch { setError(isEn ? 'Could not load statement details.' : '无法加载对账单明细。') }
    }
  }

  return <div className="mx-auto max-w-5xl space-y-4">
    <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-bold text-[#356b2f]">{isEn ? 'My Statements' : '我的对账单'}</h1><button type="button" onClick={() => window.print()} className="rounded-lg bg-[#356b2f] px-4 py-2 text-sm font-medium text-white print:hidden">{isEn ? 'Print' : '打印'}</button></div>
    {loading ? <p className="py-10 text-center text-gray-500">{isEn ? 'Loading…' : '加载中…'}</p> : error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}<button onClick={() => void load()} className="ml-3 underline">{isEn ? 'Retry' : '重试'}</button></div> : items.length === 0 ? <p className="rounded-xl border bg-white p-8 text-center text-sm text-gray-500">{isEn ? 'No statements have been issued to your account yet.' : '您的账户还没有已发送的对账单。'}</p> : <div className="space-y-3">{items.map(item => <article key={item.id} className="break-inside-avoid rounded-xl border border-[#dce7d9] bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"><div><h2 className="font-semibold">{item.customerName}</h2><p className="text-sm text-gray-500">{formatDateOnly(item.periodStart)} – {formatDateOnly(item.periodEnd)}</p></div><span className="text-xs text-gray-500">{isEn ? 'Issued' : '发送日期'}: {item.sentAt ? formatDateOnly(item.sentAt) : '—'}</span></header>
      <div className="grid grid-cols-2 gap-3 pt-3 text-sm sm:grid-cols-5">{[[isEn ? 'Opening' : '期初', item.openingBalance], [isEn ? 'Sales' : '销售', item.totalSales], [isEn ? 'Payments' : '收款', item.totalPayments], [isEn ? 'Credits' : 'Credit', item.totalCredits], [isEn ? 'Closing balance' : '期末余额', item.closingBalance]].map(([label, amount]) => <div key={String(label)}><div className="text-xs text-gray-500">{label}</div><strong>€{Number(amount).toFixed(2)}</strong></div>)}</div>
      <button type="button" onClick={() => void toggleDetails(item.id)} className="mt-3 text-sm font-medium text-[#356b2f] print:hidden">{openIds.has(item.id) ? (isEn ? 'Hide transactions' : '收起交易明细') : (isEn ? 'View transactions' : '查看交易明细')}</button>
      {openIds.has(item.id) && <div className="mt-3 space-y-3 border-t pt-3 text-sm">
        {!details[item.id] ? <p className="text-gray-500">{isEn ? 'Loading details…' : '明细加载中…'}</p> : <>
          <TransactionSection title={isEn ? 'Orders · by delivery date' : '订单 · 按配送日期'} rows={details[item.id].orders.map(row => ({ date: row.deliveryDate, name: row.code ?? '—', amount: row.amount }))} empty={isEn ? 'No orders in this period.' : '本期没有订单。'} />
          <TransactionSection title={isEn ? 'Payments' : '收款'} rows={details[item.id].payments.map(row => ({ date: row.date, name: [row.invoiceName, row.method].filter(Boolean).join(' · ') || (isEn ? 'Payment' : '收款'), amount: row.amount }))} empty={isEn ? 'No payments in this period.' : '本期没有收款。'} negative />
          <TransactionSection title={isEn ? 'Credits' : 'Credit' } rows={details[item.id].credits.map(row => ({ date: row.date, name: row.name, amount: row.amount }))} empty={isEn ? 'No credits in this period.' : '本期没有 Credit。'} negative />
        </>}
      </div>}
    </article>)}</div>}
    <style jsx global>{`@media print { body { background: white !important; } header, nav, button { display: none !important; } main { padding: 0 !important; } }`}</style>
  </div>
}

function TransactionSection({ title, rows, empty, negative = false }: { title: string; rows: Array<{ date: string | null; name: string; amount: number }>; empty: string; negative?: boolean }) {
  return <section><h3 className="mb-1 font-medium text-gray-700">{title}</h3>{rows.length ? <div className="divide-y">{rows.map((row, index) => <div key={`${row.name}-${index}`} className="flex flex-wrap justify-between gap-2 py-1.5"><span className="text-gray-600">{row.date ? formatDateOnly(row.date) : '—'} · {row.name}</span><span>{negative ? '−' : ''}€{Number(row.amount).toFixed(2)}</span></div>)}</div> : <p className="text-xs text-gray-400">{empty}</p>}</section>
}
