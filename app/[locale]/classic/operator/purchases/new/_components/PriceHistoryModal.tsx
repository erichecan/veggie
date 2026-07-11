'use client'
import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'

interface PriceHistoryPoint {
  date: string
  unitCost: number
  source: string
}

interface PriceHistoryResponse {
  lastPrice: number | null
  history: PriceHistoryPoint[]
}

/** 采购单行"查看价格历史"入口：最近一次成交价 + 最近 10 次价格走势（按商品+供应商区分） */
export default function PriceHistoryModal({
  productId,
  productName,
  supplierId,
  onClose,
  onApplyLastPrice,
}: {
  productId: string
  productName: string
  supplierId: string | null
  onClose: () => void
  onApplyLastPrice: (price: number) => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<PriceHistoryResponse | null>(null)

  async function load() {
    setLoading(true)
    const qs = supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''
    try {
      setData(await apiGet<PriceHistoryResponse>(`/api/products/${productId}/price-history${qs}`))
    } catch {
      setData({ lastPrice: null, history: [] })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [productId, supplierId])

  const chartData = (data?.history ?? [])
    .slice()
    .reverse()
    .map(p => ({ ...p, label: p.date.slice(0, 10) }))

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">{productName} · {isEn ? 'Price History' : '价格历史'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
        </div>
        {!supplierId && (
          <p className="text-xs text-amber-600">{isEn ? 'No supplier selected — showing merged history across all suppliers' : '未选定供应商，展示的是全部供应商合并历史'}</p>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'Loading…' : '加载中…'}</p>
        ) : chartData.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'No purchase price history yet' : '暂无历史采购记录'}</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-gray-500">{isEn ? 'Last purchase price' : '最近一次成交价'}</span>
              <span className="text-lg font-bold" style={{ color: PURPLE }}>
                {data?.lastPrice != null ? data.lastPrice.toFixed(2) : '—'}
              </span>
              {data?.lastPrice != null && (
                <button
                  onClick={() => onApplyLastPrice(data.lastPrice!)}
                  className="ml-auto text-xs hover:underline"
                  style={{ color: PURPLE }}
                >
                  {isEn ? 'Apply to this line' : '应用到本行单价'}
                </button>
              )}
            </div>
            <div style={{ width: '100%', height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                  <Tooltip formatter={(v: unknown) => Number(v).toFixed(2)} />
                  <Line type="monotone" dataKey="unitCost" stroke={PURPLE} strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left font-normal py-1">{isEn ? 'Date' : '日期'}</th>
                  <th className="text-left font-normal py-1">{isEn ? 'Document' : '单据'}</th>
                  <th className="text-right font-normal py-1">{isEn ? 'Unit Price' : '单价'}</th>
                </tr>
              </thead>
              <tbody>
                {chartData.slice().reverse().map((p, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="py-1">{p.label}</td>
                    <td className="py-1 text-gray-500">{p.source}</td>
                    <td className="py-1 text-right font-medium">{p.unitCost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
