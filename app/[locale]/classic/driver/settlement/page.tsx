'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, type ClientFacetDef } from '@/lib/facet-client'
import { getSession } from '@/lib/session'
import { formatDateTime } from '@/lib/format-date'

interface CommissionOrder {
  id: string
  code: string | null
  restaurantName: string
  driverCommissionTotal: number | null
  commissionFrozenAt: string | null
}

interface TripSettlement {
  id: string
  name: string
  driverId: string
  driverName: string
  status: string
  totalPayment: number
  driverCommission: number | null
  cashCollected: number | null
  onlineCollected: number | null
  totalCollected: number
  difference: number
  settlementStatus: string
  settledAt: string | null
  settledBy: string | null
  settlementNote: string | null
  restaurants: unknown[]
  commissionOrders: CommissionOrder[]
  commissionTotal: number
}

const SETTLEMENT_LABEL: Record<string, string> = {
  pending: '待提交',
  submitted: '已提交',
  confirmed: '已确认',
}
const SETTLEMENT_COLOR: Record<string, string> = {
  pending: 'bg-yellow-50 text-yellow-700',
  submitted: 'bg-blue-50 text-blue-700',
  confirmed: 'bg-green-50 text-green-700',
}

const FACET_DEFS: ClientFacetDef<TripSettlement>[] = [
  { key: 'name',   label: '行程', values: r => [r.name] },
  { key: 'driver', label: '司机', values: r => [r.driverName] },
  { key: 'status', label: '状态', values: r => [r.status] },
]

export default function DriverSettlementPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [trips, setTrips] = useState<TripSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<TripSettlement | null>(null)

  // Settlement form
  const [cashAmount, setCashAmount] = useState('')
  const [onlineAmount, setOnlineAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadTrips = useCallback(async () => {
    setLoading(true)
    try {
      const session = getSession()
      if (!session) return
      // Load completed trips for this driver
      const data = await apiGet<Array<Record<string, unknown>>>(`/api/trips?driverId=${session.userId}&status=COMPLETED`)
      // For each trip, load settlement details
      const settlements = await Promise.all(
        data.map(async (t) => {
          try {
            return await apiGet<TripSettlement>(`/api/trips/${t.id}/settlement`)
          } catch {
            return null
          }
        }),
      )
      setTrips(settlements.filter((s): s is TripSettlement => s !== null))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTrips() }, [loadTrips])

  const { facets, chips, controlPanelProps } = useFacets(FACET_DEFS.map(d => ({ key: d.key, label: d.label })))
  const filtered = filterByFacets(trips, facets, FACET_DEFS)

  async function handleSubmitSettlement() {
    if (!selected) return
    const cash = parseFloat(cashAmount)
    const online = parseFloat(onlineAmount)
    if (isNaN(cash) || isNaN(online)) {
      toast.error('请输入有效金额')
      return
    }
    setSubmitting(true)
    try {
      await apiPost(`/api/trips/${selected.id}/settlement`, {
        cashCollected: cash,
        onlineCollected: online,
        settlementNote: note || undefined,
      })
      toast.success('交账已提交')
      setSelected(null)
      setCashAmount('')
      setOnlineAmount('')
      setNote('')
      loadTrips()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <OdooControlPanel
        breadcrumb={['配送', '交账']}
        searchValue=""
        onSearch={() => {}}
        {...controlPanelProps}
        activeFilters={chips}
      />

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            加载中...
          </div>
        ) : trips.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">暂无需要交账的配送单</div>
        ) : (
          <div className="p-4 space-y-3">
            {filtered.map(t => (
              <div
                key={t.id}
                className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="font-medium text-gray-900">{t.name}</span>
                    <span className="ml-2 text-xs text-gray-400">{t.driverName}</span>
                  </div>
                  <span className={`inline-block px-2.5 py-0.5 rounded text-xs font-medium ${SETTLEMENT_COLOR[t.settlementStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                    {SETTLEMENT_LABEL[t.settlementStatus] ?? t.settlementStatus}
                  </span>
                </div>

                {/* Financial summary */}
                <div className="grid grid-cols-3 gap-3 text-center mb-3">
                  <div className="bg-gray-50 rounded px-3 py-2">
                    <div className="text-[10px] text-gray-400 mb-0.5">应收总额</div>
                    <div className="text-sm font-semibold text-gray-900">€{t.totalPayment.toFixed(2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded px-3 py-2">
                    <div className="text-[10px] text-gray-400 mb-0.5">已收总额</div>
                    <div className="text-sm font-semibold text-blue-700">€{t.totalCollected.toFixed(2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded px-3 py-2">
                    <div className="text-[10px] text-gray-400 mb-0.5">差额</div>
                    <div className={`text-sm font-semibold ${t.difference === 0 ? 'text-green-600' : t.difference > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      €{t.difference.toFixed(2)}
                    </div>
                  </div>
                </div>

                {t.commissionOrders.length > 0 && (
                  <div className="mb-3 border border-gray-100 rounded">
                    <div className="px-3 py-1.5 bg-gray-50 text-[10px] text-gray-400 flex justify-between">
                      <span>提成明细</span>
                      <span>合计工钱 €{t.commissionTotal.toFixed(2)}</span>
                    </div>
                    {t.commissionOrders.map(o => (
                      <div key={o.id} className="px-3 py-1 flex justify-between text-xs border-t border-gray-100">
                        <span className="text-gray-500">{o.code ?? o.id.slice(-8)} · {o.restaurantName}</span>
                        <span className={o.driverCommissionTotal == null ? 'text-gray-300' : 'text-gray-700 font-medium'}>
                          {o.driverCommissionTotal == null ? '未冻结' : `€${o.driverCommissionTotal.toFixed(2)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {t.cashCollected != null && t.onlineCollected != null && (
                  <div className="flex gap-4 text-xs text-gray-500 mb-3">
                    <span>现金: €{t.cashCollected.toFixed(2)}</span>
                    <span>在线: €{t.onlineCollected.toFixed(2)}</span>
                  </div>
                )}

                {t.settlementNote && (
                  <div className="text-xs text-gray-500 mb-3 bg-yellow-50 px-3 py-1.5 rounded">
                    备注: {t.settlementNote}
                  </div>
                )}

                {t.settledAt && (
                  <div className="text-[10px] text-gray-400 mb-3">
                    确认时间: {formatDateTime(t.settledAt)}
                  </div>
                )}

                {/* Actions */}
                {t.settlementStatus === 'pending' && (
                  <button
                    onClick={() => {
                      setSelected(t)
                      setCashAmount('')
                      setOnlineAmount('')
                      setNote('')
                    }}
                    className="w-full py-2 rounded text-sm font-medium text-white"
                    style={{ background: '#875A7B' }}
                  >
                    提交交账
                  </button>
                )}
                {t.settlementStatus === 'submitted' && (
                  <div className="text-center text-xs text-blue-600 py-1">等待财务确认</div>
                )}
                {t.settlementStatus === 'confirmed' && (
                  <div className="text-center text-xs text-green-600 py-1">✓ 交账已确认</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settlement submit dialog */}
      {selected && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">
              提交交账 — {selected.name}
            </h2>

            <div className="bg-gray-50 rounded px-4 py-3 text-center">
              <div className="text-xs text-gray-400">应收总额</div>
              <div className="text-xl font-bold text-gray-900">€{selected.totalPayment.toFixed(2)}</div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">现金收款 (€)</label>
              <input
                type="number"
                step="0.01"
                value={cashAmount}
                onChange={e => setCashAmount(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">在线收款 (€)</label>
              <input
                type="number"
                step="0.01"
                value={onlineAmount}
                onChange={e => setOnlineAmount(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              />
            </div>

            {(cashAmount || onlineAmount) && (
              <div className="bg-blue-50 rounded px-4 py-2 text-center">
                <div className="text-xs text-blue-600">合计收款</div>
                <div className="text-lg font-bold text-blue-700">
                  €{((parseFloat(cashAmount) || 0) + (parseFloat(onlineAmount) || 0)).toFixed(2)}
                </div>
                {(() => {
                  const diff = (parseFloat(cashAmount) || 0) + (parseFloat(onlineAmount) || 0) - selected.totalPayment
                  if (Math.abs(diff) < 0.01) return null
                  return (
                    <div className={`text-xs mt-1 ${diff > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      差额: €{diff.toFixed(2)}
                    </div>
                  )
                })()}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">备注（可选）</label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                placeholder="如有差异请说明原因..."
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none resize-none"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setSelected(null)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleSubmitSettlement}
                disabled={submitting || !cashAmount || !onlineAmount}
                className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {submitting ? '提交中...' : '确认提交'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
