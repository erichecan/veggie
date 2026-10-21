'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import type { DriverCashGroup } from '@/lib/accounting/driver-cash'

interface DriverCashResponse {
  businessDate: string
  groups: DriverCashGroup[]
  summary: { pendingGroups: number; pendingCash: number; pendingTransfer: number; oldestDays: number; lateGroups: number }
}

const ACCENT = '#875A7B'

function dmy(day: string): string {
  const [y, m, d] = day.split('-')
  return `${d}/${m}/${y}`
}

/**
 * 会计核销页「钱」板块：按「司机 × 送货日」汇总系统算出的应收，会计核对现金/转账无误后
 * 点「确认」——这一步会真正入账（生成 Payment、核销发票），所以做成两次点击才
 * 生效，且不提供撤销：写错了要走人工冲正，不是这个按钮的事（DEV-PLAN 20260924 风险点 1）。
 * 20261021 起跨天：前几天没确认的一直列着，24 小时内刚确认的也留着看（lib/accounting/driver-cash.ts）。
 */
export function DriverCashBoard({ onBusinessDate }: { onBusinessDate?: (date: string) => void }) {
  const [data, setData] = useState<DriverCashResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [armedKey, setArmedKey] = useState<string | null>(null)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiGet<DriverCashResponse>('/api/accounting/driver-cash')
      setData(res)
      onBusinessDate?.(res.businessDate)
    } catch (e) {
      // 这里拿不到 businessDate，WriteOffBoard 会一直等不到日期——必须让会计能看到
      // 失败并重试，不能让它默默转圈（20260924 code-review 发现）
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load() }, [load])

  async function confirm(g: DriverCashGroup) {
    const key = `${g.businessDate}|${g.driverName}`
    setConfirmingKey(key)
    setError(null)
    try {
      await apiPost('/api/accounting/driver-cash/confirm', { driverName: g.driverName, businessDate: g.businessDate })
      setArmedKey(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败')
    } finally {
      setConfirmingKey(null)
    }
  }

  const byDay = useMemo(() => {
    const m = new Map<string, DriverCashGroup[]>()
    for (const g of data?.groups ?? []) m.set(g.businessDate, [...(m.get(g.businessDate) ?? []), g])
    return [...m.entries()]
  }, [data])

  const s = data?.summary

  return (
    <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center flex-wrap gap-x-3 gap-y-1">
        <span className="font-semibold text-gray-700 text-sm">💰 钱 · 司机收款确认</span>
        <span className="text-xs text-gray-400">按司机 × 送货日自动算出（只算已出车的单），不限日期；会计核对无误后确认——确认即入账，不可撤销</span>
        {s && s.pendingGroups > 0 && (
          <span className="ml-auto text-xs font-medium text-red-600" data-testid="cash-pending-summary">
            待确认 {s.pendingGroups} 笔 · 现金 €{s.pendingCash.toFixed(2)} · 转账 €{s.pendingTransfer.toFixed(2)}{s.oldestDays > 0 ? ` · 最早 ${s.oldestDays} 天前` : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="px-5 py-2 bg-red-50 text-red-600 text-sm border-b border-red-100 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => load()} className="px-2 py-1 border border-red-300 rounded text-xs text-red-700 shrink-0">
            重试
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="text-center py-10 text-gray-400 text-sm">加载中…</div>
      ) : byDay.length === 0 ? (
        <div className="text-center py-10 text-green-600 text-sm">✅ 所有已出车的司机收款都已确认</div>
      ) : (
        <div className="divide-y divide-gray-100" data-testid="cash-board">
          {byDay.map(([day, groups]) => (
            <div key={day}>
              <div className="px-5 py-1.5 bg-gray-50/60 text-xs font-semibold text-gray-600 flex items-center gap-2">
                <span>送货日期 {dmy(day)}</span>
                {day === data?.businessDate && <span className="px-1.5 py-0.5 rounded bg-purple-50 text-[11px]" style={{ color: ACCENT }}>今天</span>}
                {groups[0].daysAgo > 0 && groups.some(g => !g.confirmed) && (
                  <span className={`text-[11px] ${groups[0].daysAgo >= 2 ? 'text-red-600' : 'text-amber-600'}`}>{groups[0].daysAgo} 天前，还有未确认</span>
                )}
              </div>
              {groups.map(d => {
                const key = `${d.businessDate}|${d.driverName}`
                const isArmed = armedKey === key
                const isConfirming = confirmingKey === key
                return (
                  <div key={key} className="flex items-center gap-6 px-5 py-3 flex-wrap" data-testid={`cash-row-${d.businessDate}-${d.driverName}`}>
                    <span className="font-semibold text-gray-900 w-24 shrink-0">{d.driverName}</span>
                    <span className="flex items-center gap-1 text-sm text-gray-700">
                      <span className="text-xs text-gray-400">现金</span>
                      <span className="font-mono font-medium">€{d.cashTotal.toFixed(2)}</span>
                    </span>
                    <span className="flex items-center gap-1 text-sm text-gray-700">
                      <span className="text-xs text-gray-400">转账</span>
                      <span className="font-mono font-medium">€{d.transferTotal.toFixed(2)}</span>
                    </span>
                    <span className="flex items-center gap-1 text-sm text-gray-700">
                      <span className="text-xs text-gray-400">合计</span>
                      <span className="font-mono font-semibold">€{d.total.toFixed(2)}</span>
                    </span>
                    <span className="text-xs text-gray-400">{d.orderCount} 单</span>
                    {d.lateOrderCount > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700" title="这一天确认之后又补进来的单，同一司机同一天只能确认一次，请人工处理">
                        ⚠️ 确认后又补进 {d.lateOrderCount} 单 €{d.lateAmount.toFixed(2)}，需人工处理
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                      {d.confirmed ? (
                        <span className="text-xs px-2 py-1 rounded bg-green-50 text-green-700 font-medium">
                          ✅ 已确认{d.confirmedByName ? ` · ${d.confirmedByName}` : ''}{d.confirmedAt ? ` · ${new Date(d.confirmedAt).toLocaleString('en-GB')}` : ''}
                        </span>
                      ) : isArmed ? (
                        <>
                          <span className="text-xs text-red-600 font-medium">确定要确认 {dmy(d.businessDate)} {d.driverName} 的收款吗？入账后不可撤销</span>
                          <button
                            onClick={() => confirm(d)}
                            disabled={isConfirming}
                            className="px-3 py-1 text-white rounded text-xs font-medium disabled:opacity-50"
                            style={{ background: '#dc2626' }}
                            data-testid="cash-confirm-final"
                          >
                            {isConfirming ? '入账中…' : '确定入账'}
                          </button>
                          <button
                            onClick={() => setArmedKey(null)}
                            disabled={isConfirming}
                            className="px-2 py-1 border border-gray-300 rounded text-xs text-gray-500"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setArmedKey(key)}
                          className="px-3 py-1 text-white rounded text-xs font-medium"
                          style={{ background: ACCENT }}
                          data-testid="cash-confirm"
                        >
                          确认
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
