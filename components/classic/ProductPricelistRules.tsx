'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiGet } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'
import { translateLogDetail, fieldLabel } from '@/lib/action-log-i18n'

/**
 * 商品页「价格表」区块(20261008)：反查哪些价格表在给这个商品定价、各卖多少钱，
 * 以及这个商品的价格规则改价历史。数据来自 GET /api/products/[id]/pricelist-rules。
 * 没有价格表读权限(403)时整块不显示。
 */

interface RuleRow {
  itemId: string
  applyOn: string
  minQty: number
  dateStart: string | null
  dateEnd: string | null
  uomName: string | null
  computeType: string
  summary: string
  price: number | null
  expired: boolean
}

interface PricelistRow {
  id: string
  name: string
  active: boolean
  customerCount: number
  effectivePrice: number | null
  hasDirectRule: boolean
  rules: RuleRow[]
}

interface HistoryRow {
  id: string
  userName: string
  detail: string | null
  changes: Record<string, { before: unknown; after: unknown }> | null
  createdAt: string
}

interface Resp {
  listPrice: number | null
  pricelists: PricelistRow[]
  history: HistoryRow[]
}

const SCOPE: Record<string, { zh: string; en: string; color: string }> = {
  product: { zh: '本商品', en: 'This product', color: '#875A7B' },
  variant: { zh: '本商品', en: 'This product', color: '#875A7B' },
  category: { zh: '分类', en: 'Category', color: '#2563eb' },
  global: { zh: '全场', en: 'All products', color: '#6b7280' },
}

function fmtVal(v: unknown, isEn: boolean): string {
  if (v == null || v === '') return isEn ? '(none)' : '（无）'
  return String(v)
}

export default function ProductPricelistRules({ productId, prefix, isEn }: { productId: string; prefix: string; isEn: boolean }) {
  const [data, setData] = useState<Resp | null>(null)
  const [hidden, setHidden] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiGet<Resp>(`/api/products/${productId}/pricelist-rules`)
      .then(r => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setHidden(true) })
    return () => { cancelled = true }
  }, [productId])

  if (hidden) return null
  if (!data) return <p className="text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>

  return (
    <div className="space-y-3">
      {data.pricelists.length === 0 ? (
        <p className="text-xs text-gray-400">
          {isEn ? 'No pricelist rule applies to this product — it sells at the Sales Price.' : '没有价格表规则作用在这个商品上，按销售价出售。'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs max-w-5xl">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1.5 pr-3 font-semibold">{isEn ? 'Pricelist' : '价格表'}</th>
                <th className="py-1.5 pr-3 font-semibold text-right">{isEn ? 'Customers' : '客户数'}</th>
                <th className="py-1.5 pr-3 font-semibold">{isEn ? 'Rules' : '规则'}</th>
                <th className="py-1.5 font-semibold text-right">{isEn ? 'Price (qty 1, today)' : '成交价(1 件，今天)'}</th>
              </tr>
            </thead>
            <tbody>
              {data.pricelists.map(pl => (
                <tr key={pl.id} className="border-b border-gray-100 align-top">
                  <td className="py-1.5 pr-3">
                    <Link href={`${prefix}/classic/operator/pricelists/${pl.id}`} className="hover:underline" style={{ color: '#875A7B' }}>
                      {pl.name}
                    </Link>
                    {!pl.active && <span className="ml-1 text-gray-400">{isEn ? '(archived)' : '(已归档)'}</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-gray-600">{pl.customerCount}</td>
                  <td className="py-1.5 pr-3">
                    <ul className="space-y-0.5">
                      {pl.rules.map(r => {
                        const scope = SCOPE[r.applyOn] ?? SCOPE.global
                        return (
                          <li key={r.itemId} className={r.expired ? 'text-gray-300 line-through' : 'text-gray-700'}
                            title={r.expired ? (isEn ? 'Outside its date range' : '不在生效日期内') : undefined}>
                            <span className="inline-block px-1 mr-1 rounded text-[10px] text-white" style={{ background: scope.color }}>
                              {isEn ? scope.en : scope.zh}
                            </span>
                            {r.summary}
                            {r.uomName && <span className="ml-1 text-gray-400">/{r.uomName}</span>}
                            {(r.dateStart || r.dateEnd) && <span className="ml-1 text-gray-400">[{r.dateStart ?? '…'} ~ {r.dateEnd ?? '…'}]</span>}
                            {r.price != null && r.computeType !== 'fixed' && <span className="ml-1 text-gray-500">→ €{r.price.toFixed(2)}</span>}
                          </li>
                        )
                      })}
                    </ul>
                  </td>
                  <td className="py-1.5 text-right font-medium text-gray-900">
                    {pl.effectivePrice != null
                      ? <span>€{pl.effectivePrice.toFixed(2)}</span>
                      : <span className="text-gray-400" title={isEn ? 'No rule matches qty 1 today; Sales Price applies' : '数量 1、今天没有规则命中，按销售价'}>
                          {data.listPrice != null ? `€${data.listPrice.toFixed(2)}` : '—'}*
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowHistory(v => !v)} className="text-xs hover:underline" style={{ color: '#875A7B' }}>
          {showHistory ? '▾' : '▸'} {isEn ? `Pricelist price history (${data.history.length})` : `价格表改价历史（${data.history.length}）`}
        </button>
        {showHistory && (
          data.history.length === 0 ? (
            <p className="mt-1 text-xs text-gray-400">{isEn ? 'No pricelist price changes recorded yet.' : '还没有价格表改价记录。'}</p>
          ) : (
            <ul className="mt-2 space-y-1.5 max-w-5xl">
              {data.history.map(h => (
                <li key={h.id} className="text-xs text-gray-600">
                  <span className="text-gray-400">{formatDateTime(h.createdAt)}</span>
                  {' · '}<span className="font-medium text-gray-800">{h.userName}</span>
                  {h.detail && <> — {translateLogDetail(h.detail, isEn)}</>}
                  {h.changes && Object.entries(h.changes).map(([k, v]) => (
                    <span key={k} className="ml-2 whitespace-nowrap">
                      {fieldLabel(k, isEn)}: <span className="text-red-500 line-through">{fmtVal(v.before, isEn)}</span>
                      {' → '}<span className="text-green-700 font-medium">{fmtVal(v.after, isEn)}</span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  )
}
