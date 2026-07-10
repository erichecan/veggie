'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'

interface TripSettlement {
  id: string
  name: string | null
  driverName: string | null
  status: string
  totalPayment: number
  cashCollected: number | null
  onlineCollected: number | null
  settlementStatus: string | null
  settledAt: string | null
  settlementNote: string | null
}

type Tab = 'submitted' | 'confirmed' | 'all'

const TAB_LABEL: Record<Tab, string> = {
  submitted: '待确认',
  confirmed: '已确认',
  all: '全部',
}

const SETTLEMENT_LABEL: Record<string, string> = {
  pending: '待提交',
  submitted: '待确认',
  confirmed: '已确认',
}
const SETTLEMENT_COLOR: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-500',
  submitted: 'bg-blue-50 text-blue-700',
  confirmed: 'bg-green-50 text-green-700',
}

export default function FinanceSettlementsPage() {
  const [trips, setTrips] = useState<TripSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('submitted')
  const [acting, setActing] = useState<string | null>(null)

  // 退回对话框
  const [rejectTarget, setRejectTarget] = useState<TripSettlement | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const load = useCallback(async (t: Tab) => {
    setLoading(true)
    try {
      const query = t === 'all' ? '' : `?settlementStatus=${t}`
      const data = await apiGet<TripSettlement[]>(`/api/trips${query}`)
      // 财务确认页只关心已提交及之后的交账，过滤掉司机尚未提交（pending）的行程
      setTrips(data.filter(d => d.settlementStatus && d.settlementStatus !== 'pending'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [tab, load])

  async function confirmSettlement(t: TripSettlement) {
    if (!confirm(`确认 ${t.driverName ?? '司机'} 的交账金额无误？确认后将标记为已结算。`)) return
    setActing(t.id)
    try {
      await apiPut(`/api/trips/${t.id}/settlement`, { confirmed: true })
      toast.success('交账已确认')
      load(tab)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '确认失败')
    } finally {
      setActing(null)
    }
  }

  async function submitReject() {
    if (!rejectTarget) return
    setActing(rejectTarget.id)
    try {
      await apiPut(`/api/trips/${rejectTarget.id}/settlement`, {
        confirmed: false,
        settlementNote: rejectReason || '财务退回，请重新提交',
      })
      toast.success('已退回司机重新提交')
      setRejectTarget(null)
      setRejectReason('')
      load(tab)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '退回失败')
    } finally {
      setActing(null)
    }
  }

  function diffOf(t: TripSettlement): number {
    const collected = (t.cashCollected ?? 0) + (t.onlineCollected ?? 0)
    return collected - t.totalPayment
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">司机交账确认</h1>
        <p className="text-sm text-gray-500 mt-1">核对司机交回的现金 / 在线收款与系统应收是否一致</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {(['submitted', 'confirmed', 'all'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-[#875A7B] text-[#875A7B]' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-gray-400">
          <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
          加载中...
        </div>
      ) : trips.length === 0 ? (
        <div className="py-24 text-center text-gray-400 text-sm">
          {tab === 'submitted' ? '暂无待确认的交账' : '暂无交账记录'}
        </div>
      ) : (
        <div className="space-y-3">
          {trips.map(t => {
            const diff = diffOf(t)
            const collected = (t.cashCollected ?? 0) + (t.onlineCollected ?? 0)
            const matched = Math.abs(diff) < 0.01
            return (
              <div key={t.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <span className="font-bold text-gray-900">{t.name ?? '行程'}</span>
                    <span className="ml-2 text-xs text-gray-400">{t.driverName ?? '—'}</span>
                  </div>
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${SETTLEMENT_COLOR[t.settlementStatus ?? ''] ?? 'bg-gray-100 text-gray-500'}`}>
                    {SETTLEMENT_LABEL[t.settlementStatus ?? ''] ?? t.settlementStatus}
                  </span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <Cell label="应收总额" value={`€${t.totalPayment.toFixed(2)}`} />
                  <Cell label="现金收款" value={`€${(t.cashCollected ?? 0).toFixed(2)}`} color="text-orange-600" />
                  <Cell label="在线收款" value={`€${(t.onlineCollected ?? 0).toFixed(2)}`} color="text-blue-600" />
                  <Cell
                    label="差额"
                    value={`€${diff.toFixed(2)}`}
                    color={matched ? 'text-green-600' : diff > 0 ? 'text-blue-600' : 'text-red-600'}
                  />
                </div>

                {!matched && (
                  <div className="mb-3 px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600">
                    ⚠️ 已收 €{collected.toFixed(2)} 与应收 €{t.totalPayment.toFixed(2)} 不一致，请与司机核对后再确认
                  </div>
                )}

                {t.settlementNote && (
                  <div className="text-xs text-gray-500 mb-3 bg-yellow-50 px-3 py-1.5 rounded">备注：{t.settlementNote}</div>
                )}

                {t.settledAt && (
                  <div className="text-[11px] text-gray-400 mb-3">确认时间：{formatDateTime(t.settledAt)}</div>
                )}

                {t.settlementStatus === 'submitted' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => confirmSettlement(t)}
                      disabled={acting === t.id}
                      className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                      style={{ background: '#875A7B' }}
                    >
                      {acting === t.id ? '处理中…' : '✓ 确认交账'}
                    </button>
                    <button
                      onClick={() => { setRejectTarget(t); setRejectReason('') }}
                      disabled={acting === t.id}
                      className="flex-1 py-2 rounded border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      退回重交
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 退回对话框 */}
      {rejectTarget && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">退回交账 — {rejectTarget.name ?? '行程'}</h2>
            <p className="text-xs text-gray-500">退回后司机需重新提交交账。请填写退回原因：</p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder="如：现金金额与系统应收不符，请核对…"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none resize-none"
            />
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setRejectTarget(null); setRejectReason('') }}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={submitReject}
                disabled={acting === rejectTarget.id}
                className="flex-1 py-2 rounded text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
              >
                {acting === rejectTarget.id ? '处理中…' : '确认退回'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Cell({ label, value, color = 'text-gray-900' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
      <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  )
}
