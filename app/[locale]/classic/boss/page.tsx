'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { eur } from '@/lib/format-money'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, Legend,
} from 'recharts'

interface DayMetrics {
  salesExTax: number; salesIncTax: number; grossProfit: number; costCoverageRate: number
  orderCount: number; activeCustomers: number; shortageLines: number; orderLines: number
  creditNoteAmount: number; scrapAmount: number; purchaseExTax: number
  arBalance: number; arOverdue: number
}

interface Snapshot extends DayMetrics { id: string; snapshotDate: string; computedAt: string }

interface Overview {
  yesterday: Snapshot | null
  today: DayMetrics
  todayOps: {
    toDeliverCount: number
    toDeliverAmount: number
    waves: Array<{ driver: string | null; wave_type: string | null; order_count: number; dispatched: boolean }>
    pendingShortage: number
  }
  redFlags: {
    negativeStock: { total: number; items: Array<{ id: string; name: string; spec: string | null; qty: number }> }
    stalePending: { total: number; items: Array<{ id: string; code: string | null; customer: string; amount: number; createdAt: string }> }
    churnRisk: Array<{ customer_id: string; customer_name: string; prior_orders: number; prior_amount: number; last_order_at: string }>
  }
  ar: {
    balance: number
    overdue: number
    topDebtors: Array<{ customer_id: string; customer_name: string; amount_due: number; invoice_count: number }>
  }
}

function KpiCard({ label, value, sub, tone, href }: {
  label: string; value: string; sub?: string
  tone?: 'default' | 'good' | 'bad'; href?: string
}) {
  const color = tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-red-600' : 'text-gray-900'
  const inner = (
    <div className={`border rounded-lg p-4 bg-white ${href ? 'hover:shadow-sm hover:border-gray-300 transition' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

export default function ClassicBossDashboard() {
  const [data, setData] = useState<Overview | null>(null)
  const [trend, setTrend] = useState<Snapshot[]>([])
  const [recomputing, setRecomputing] = useState(false)
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  function load() {
    apiGet<Overview>('/api/analytics/overview').then(setData).catch((e) => toast.error(e.message))
    apiGet<{ items: Snapshot[] }>('/api/analytics/snapshots').then((d) => setTrend(d.items ?? [])).catch(() => {})
  }
  useEffect(() => { load() }, [])

  async function recompute() {
    if (recomputing) return
    setRecomputing(true)
    try {
      const r = await apiPost<{ recomputed: number }>('/api/analytics/snapshots', { days: 7 })
      toast.success(`已重算最近 ${r.recomputed} 天`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRecomputing(false)
    }
  }

  if (!data) {
    return <div className="flex items-center justify-center py-32 text-gray-400 text-sm">加载中…</div>
  }

  const y = data.yesterday
  const t = data.today
  const shortageRate = (m: { shortageLines: number; orderLines: number } | null) =>
    m && m.orderLines > 0 ? `${((m.shortageLines / m.orderLines) * 100).toFixed(1)}%` : '—'

  const trendData = trend.map((s) => ({
    day: String(s.snapshotDate).slice(5, 10),
    销售额: Number(s.salesIncTax),
    毛利: Number(s.grossProfit),
    订单数: s.orderCount,
  }))

  const todayLabel = new Date().toLocaleDateString('en-GB', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">经营总览</h1>
          <p className="text-sm text-gray-400 mt-0.5">{todayLabel} · 历史读每日快照，今日实时</p>
        </div>
        <button
          onClick={recompute}
          disabled={recomputing}
          className="text-xs text-gray-500 border rounded px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
        >
          {recomputing ? '重算中…' : '重算最近 7 天'}
        </button>
      </div>

      {/* 昨日 */}
      <section>
        <h2 className="text-sm font-medium text-gray-500 mb-2">昨天</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard label="销售额（税后）" value={eur(y?.salesIncTax)} sub={`税前 ${eur(y?.salesExTax)}`}
            href={`${prefix}/classic/boss/sales-report`} />
          <KpiCard label="毛利" value={eur(y?.grossProfit)}
            sub={`成本覆盖率 ${((Number(y?.costCoverageRate ?? 0)) * 100).toFixed(0)}%（余用标准成本）`}
            href={`${prefix}/classic/boss/analytics/margin`} />
          <KpiCard label="订单数" value={String(y?.orderCount ?? 0)} sub={`活跃客户 ${y?.activeCustomers ?? 0}`} />
          <KpiCard label="缺货率" value={shortageRate(y)} sub={`${y?.shortageLines ?? 0} / ${y?.orderLines ?? 0} 行`}
            tone={y && y.shortageLines > 0 ? 'bad' : 'default'} />
          <KpiCard label="退货 + 损耗" value={eur(Number(y?.creditNoteAmount ?? 0) + Number(y?.scrapAmount ?? 0))}
            sub={`退货 ${eur(y?.creditNoteAmount)} · 损耗 ${eur(y?.scrapAmount)}`} />
        </div>
      </section>

      {/* 今日 */}
      <section>
        <h2 className="text-sm font-medium text-gray-500 mb-2">今天（实时）</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="今日销售额（税后）" value={eur(t.salesIncTax)} sub={`${t.orderCount} 单 · ${t.activeCustomers} 客户`} />
          <KpiCard label="待配送" value={String(data.todayOps.toDeliverCount)}
            sub={eur(data.todayOps.toDeliverAmount)} />
          <KpiCard label="今日波次" value={`${data.todayOps.waves.filter(w => w.dispatched).length} / ${data.todayOps.waves.length} 已出发`}
            sub={data.todayOps.waves.map(w => `${w.driver ?? '未定'}(${w.order_count})`).join(' · ') || '今日暂无波次'} />
          <KpiCard label="缺货待处理" value={String(data.todayOps.pendingShortage)}
            tone={data.todayOps.pendingShortage > 0 ? 'bad' : 'good'} />
        </div>
      </section>

      {/* 30 天趋势 */}
      <section className="border rounded-lg p-4 bg-white">
        <h2 className="text-sm font-medium text-gray-500 mb-3">近 30 天趋势（税后销售额 / 毛利 / 订单数）</h2>
        {trendData.length === 0 ? (
          <div className="text-center text-gray-400 py-10 text-sm">暂无快照数据</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trendData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
              <XAxis dataKey="day" fontSize={11} />
              <YAxis yAxisId="amt" fontSize={11} tickFormatter={(v) => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
              <YAxis yAxisId="cnt" orientation="right" fontSize={11} allowDecimals={false} />
              <Tooltip formatter={(v: unknown, name: unknown) => name === '订单数' ? Number(v) : eur(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="cnt" dataKey="订单数" fill="#E5E0EC" radius={[2, 2, 0, 0]} />
              <Line yAxisId="amt" type="monotone" dataKey="销售额" stroke="#875A7B" strokeWidth={2} dot={false} />
              <Line yAxisId="amt" type="monotone" dataKey="毛利" stroke="#28a745" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* 红灯区 + 应收 */}
      <section className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-red-600 mb-2">
            ⚠ 流失预警（前 30 天常下单、近 7 天没动静）
            <Link href={`${prefix}/classic/boss/analytics/customers`} className="text-xs text-gray-400 ml-2 font-normal hover:underline">全部 →</Link>
          </h2>
          {data.redFlags.churnRisk.length === 0 ? (
            <div className="text-gray-400 text-sm py-4">没有流失预警 👍</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.redFlags.churnRisk.map((c) => (
                  <tr key={c.customer_id} className="border-t first:border-t-0">
                    <td className="py-1.5">{c.customer_name}</td>
                    <td className="py-1.5 text-right text-gray-500">{c.prior_orders} 单</td>
                    <td className="py-1.5 text-right tabular-nums">{eur(c.prior_amount)}</td>
                    <td className="py-1.5 text-right text-gray-400 text-xs">
                      最后 {String(c.last_order_at).slice(5, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-700 mb-2">
            应收 {eur(data.ar.balance)}
            {Number(data.ar.overdue) > 0 && <span className="text-red-600 ml-2">其中逾期 {eur(data.ar.overdue)}</span>}
            <Link href={`${prefix}/classic/boss/analytics/ar-aging`} className="text-xs text-gray-400 ml-2 font-normal hover:underline">账龄 →</Link>
          </h2>
          {data.ar.topDebtors.length === 0 ? (
            <div className="text-gray-400 text-sm py-4">当前无未收发票</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.ar.topDebtors.map((d) => (
                  <tr key={d.customer_id} className="border-t first:border-t-0">
                    <td className="py-1.5">{d.customer_name}</td>
                    <td className="py-1.5 text-right text-gray-500">{d.invoice_count} 张</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{eur(d.amount_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-red-600 mb-2">
            负库存商品（{data.redFlags.negativeStock.total}）
          </h2>
          {data.redFlags.negativeStock.items.length === 0 ? (
            <div className="text-gray-400 text-sm py-4">没有负库存 👍</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.redFlags.negativeStock.items.map((prod) => (
                  <tr key={prod.id} className="border-t first:border-t-0">
                    <td className="py-1.5">{prod.name}{prod.spec ? ` (${prod.spec})` : ''}</td>
                    <td className="py-1.5 text-right tabular-nums text-red-600">{prod.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-amber-700 mb-2">
            超 3 天未确认报价单（{data.redFlags.stalePending.total}）
          </h2>
          {data.redFlags.stalePending.items.length === 0 ? (
            <div className="text-gray-400 text-sm py-4">没有积压报价单 👍</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.redFlags.stalePending.items.map((o) => (
                  <tr key={o.id} className="border-t first:border-t-0">
                    <td className="py-1.5 text-gray-500">{o.code ?? o.id.slice(0, 8)}</td>
                    <td className="py-1.5">{o.customer}</td>
                    <td className="py-1.5 text-right tabular-nums">{eur(o.amount)}</td>
                    <td className="py-1.5 text-right text-gray-400 text-xs">{String(o.createdAt).slice(5, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
