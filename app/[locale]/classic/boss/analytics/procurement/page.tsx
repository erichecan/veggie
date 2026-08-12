'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts'

interface Procurement {
  summary: { purchaseExTax: number; poCount: number; supplierCount: number; scrapAmount: number }
  bySupplier: Array<{
    supplierId: string; supplierName: string; poCount: number; amountExTax: number; fulfillmentRate: number | null
    /** 台账 E7：按收齐日 vs 预计到货日；null = 没有可判定的单，界面显示「—」而不是 0% */
    onTimeRate: number | null; onTimeMeasured: number; onTimeLate: number
    onTimePending: number; onTimeNoExpected: number
  }>
  priceTrends: Array<{
    productId: string; productName: string; buys: number
    minCost: number; maxCost: number; latestCost: number; latestSupplier: string
    latestDate: string; prevCost: number | null; changePct: number | null
  }>
  turnover: Array<{ productId: string; productName: string; qtyOnHand: number; dailyQty: number; days: number | null }>
  scrap: Array<{ productId: string; productName: string; qty: number; amount: number }>
}

interface Shortage {
  summary: { shortageLines: number; orderLines: number; shortageRate: number; productsAffected: number; unlinked: number }
  daily: Array<{ day: string; shortage_lines: number; order_lines: number }>
  byProduct: Array<{
    product_id: string; product_name: string; times: number; short_qty: number
    affected_orders: number; qty_on_hand: number | null
    has_suggestion: boolean; has_incoming_po: boolean
  }>
}

type Tab = 'supplier' | 'price' | 'stock' | 'shortage'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'supplier', label: '供应商 & 满足率' },
  { key: 'price', label: '进价趋势' },
  { key: 'stock', label: '周转 & 损耗' },
  { key: 'shortage', label: '缺货 × 采购联动' },
]

export default function ProcurementAnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [tab, setTab] = useState<Tab>('supplier')
  const [proc, setProc] = useState<Procurement | null>(null)
  const [short, setShort] = useState<Shortage | null>(null)

  const load = useCallback((r: DateRange) => {
    setProc(null)
    setShort(null)
    apiGet<Procurement>(`/api/analytics/procurement?from=${r.from}&to=${r.to}`)
      .then(setProc).catch((e) => toast.error(e.message))
    apiGet<Shortage>(`/api/analytics/shortage?from=${r.from}&to=${r.to}`)
      .then(setShort).catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const shortDaily = (short?.daily ?? []).map((d) => ({
    day: String(d.day).slice(5, 10),
    缺货行: d.shortage_lines,
    缺货率: d.order_lines > 0 ? Math.round((d.shortage_lines / d.order_lines) * 1000) / 10 : 0,
  }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">采购运营分析</h1>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      {!proc || !short ? (
        <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">期内采购额（税前）</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(proc.summary.purchaseExTax)}</div>
              <div className="text-xs text-gray-400 mt-1">{proc.summary.poCount} 张 PO · {proc.summary.supplierCount} 家供应商</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">缺货率</div>
              <div className={`text-2xl font-semibold mt-1 ${short.summary.shortageRate > 0.02 ? 'text-red-600' : ''}`}>
                {(short.summary.shortageRate * 100).toFixed(1)}%</div>
              <div className="text-xs text-gray-400 mt-1">{short.summary.shortageLines} / {short.summary.orderLines} 行</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">缺货商品</div>
              <div className="text-2xl font-semibold mt-1">{short.summary.productsAffected}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">采购盲区</div>
              <div className={`text-2xl font-semibold mt-1 ${short.summary.unlinked > 0 ? 'text-red-600' : 'text-green-700'}`}>
                {short.summary.unlinked}</div>
              <div className="text-xs text-gray-400 mt-1">缺货但无建议也无在途 PO</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">期内损耗</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(proc.summary.scrapAmount)}</div></div>
          </div>

          <div className="flex items-center gap-2 border-b">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === t.key ? 'border-[#875A7B] text-[#875A7B] font-medium' : 'border-transparent text-gray-500'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'supplier' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">供应商</th>
                    <th className="px-3 py-2 font-medium text-right">PO 数</th>
                    <th className="px-3 py-2 font-medium text-right">采购额（税前）</th>
                    <th className="px-3 py-2 font-medium text-right">到货满足率</th>
                    <th className="px-3 py-2 font-medium text-right" title="按收齐日对比预计到货日；只统计已收齐且填了预计到货日的采购单">到货准时率</th>
                  </tr>
                </thead>
                <tbody>
                  {proc.bySupplier.map((s) => (
                    <tr key={s.supplierId} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-1.5">{s.supplierName}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{s.poCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(s.amountExTax)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${s.fulfillmentRate !== null && s.fulfillmentRate < 0.9 ? 'text-red-600' : ''}`}>
                        {s.fulfillmentRate === null ? '—' : `${(s.fulfillmentRate * 100).toFixed(0)}%`}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${s.onTimeRate !== null && s.onTimeRate < 0.8 ? 'text-red-600' : ''}`}
                        title={`已判定 ${s.onTimeMeasured} 单（迟到 ${s.onTimeLate}）· 未收齐 ${s.onTimePending} · 未填预计到货日 ${s.onTimeNoExpected}`}>
                        {s.onTimeRate === null ? '—' : `${(s.onTimeRate * 100).toFixed(0)}%`}
                        <span className="text-gray-400 text-xs ml-1">/{s.onTimeMeasured}</span>
                      </td>
                    </tr>
                  ))}
                  {proc.bySupplier.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400">期内没有已确认的采购单</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'price' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">商品（期内采购额 TOP 20）</th>
                    <th className="px-3 py-2 font-medium text-right">采购次数</th>
                    <th className="px-3 py-2 font-medium text-right">期内最低</th>
                    <th className="px-3 py-2 font-medium text-right">期内最高</th>
                    <th className="px-3 py-2 font-medium text-right">最新进价</th>
                    <th className="px-3 py-2 font-medium text-right">环比上次</th>
                    <th className="px-3 py-2 font-medium">最新供应商</th>
                  </tr>
                </thead>
                <tbody>
                  {proc.priceTrends.map((t) => (
                    <tr key={t.productId} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-1.5">{t.productName}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{t.buys}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(t.minCost)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(t.maxCost)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(t.latestCost)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${t.changePct === null ? 'text-gray-400' : t.changePct > 0 ? 'text-red-600' : t.changePct < 0 ? 'text-green-700' : ''}`}>
                        {t.changePct === null ? '—' : `${t.changePct > 0 ? '+' : ''}${t.changePct.toFixed(1)}%`}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500">{t.latestSupplier}</td>
                    </tr>
                  ))}
                  {proc.priceTrends.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">期内没有采购价格数据</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'stock' && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="border rounded overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 text-sm font-medium">慢周转 TOP 20（有库存商品，按可卖天数降序）</div>
                <table className="w-full text-sm">
                  <thead className="text-left text-gray-500">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">商品</th>
                      <th className="px-3 py-1.5 font-medium text-right">库存</th>
                      <th className="px-3 py-1.5 font-medium text-right">日均销量</th>
                      <th className="px-3 py-1.5 font-medium text-right">可卖天数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proc.turnover.map((t) => (
                      <tr key={t.productId} className="border-t">
                        <td className="px-3 py-1.5">{t.productName}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{t.qtyOnHand}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{t.dailyQty}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${t.days === null ? 'text-red-600' : t.days > 7 ? 'text-amber-600' : ''}`}>
                          {t.days === null ? '30 天无销量' : `${t.days} 天`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border rounded overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 text-sm font-medium">期内损耗 TOP 10（报废 + 盘亏，按成本计）</div>
                <table className="w-full text-sm">
                  <thead className="text-left text-gray-500">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">商品</th>
                      <th className="px-3 py-1.5 font-medium text-right">数量</th>
                      <th className="px-3 py-1.5 font-medium text-right">损耗额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proc.scrap.map((s) => (
                      <tr key={s.productId} className="border-t">
                        <td className="px-3 py-1.5">{s.productName}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{s.qty}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red-600">{eur(s.amount)}</td>
                      </tr>
                    ))}
                    {proc.scrap.length === 0 && (
                      <tr><td colSpan={3} className="px-3 py-8 text-center text-gray-400">期内没有损耗记录 👍</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'shortage' && (
            <>
              <div className="border rounded-lg p-4">
                <h2 className="text-sm font-medium text-gray-500 mb-3">每日缺货（行数 + 缺货率%）</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={shortDaily} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <XAxis dataKey="day" fontSize={11} />
                    <YAxis yAxisId="cnt" fontSize={11} allowDecimals={false} />
                    <YAxis yAxisId="pct" orientation="right" fontSize={11} tickFormatter={(v) => `${v}%`} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="cnt" dataKey="缺货行" fill="#f8d7da" radius={[2, 2, 0, 0]} />
                    <Line yAxisId="pct" type="monotone" dataKey="缺货率" stroke="#dc3545" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">商品</th>
                      <th className="px-3 py-2 font-medium text-right">缺货次数</th>
                      <th className="px-3 py-2 font-medium text-right">缺货量</th>
                      <th className="px-3 py-2 font-medium text-right">影响订单</th>
                      <th className="px-3 py-2 font-medium text-right">当前库存</th>
                      <th className="px-3 py-2 font-medium">采购联动</th>
                    </tr>
                  </thead>
                  <tbody>
                    {short.byProduct.map((r) => (
                      <tr key={r.product_id} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-1.5">{r.product_name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.times}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.short_qty}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.affected_orders}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${(r.qty_on_hand ?? 0) <= 0 ? 'text-red-600' : ''}`}>
                          {r.qty_on_hand ?? '—'}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.has_incoming_po ? (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">有在途 PO</span>
                          ) : r.has_suggestion ? (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">有采购建议</span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">⚠ 无采购动作</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {short.byProduct.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">期内没有缺货记录 👍</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
