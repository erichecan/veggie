'use client'
import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPost } from '@/lib/api'

interface DriverCashRow {
  driverName: string
  cashTotal: number
  transferTotal: number
  total: number
  orderCount: number
  confirmed: boolean
  confirmedAt: string | null
  confirmedByName: string | null
}

interface DriverCashResponse {
  businessDate: string
  drivers: DriverCashRow[]
}

const ACCENT = '#875A7B'

/**
 * 会计核销页「钱」板块：按司机汇总系统算出的今日应收，会计核对现金/转账无误后
 * 点「确认」——这一步会真正入账（生成 Payment、核销发票），所以做成两次点击才
 * 生效，且不提供撤销：写错了要走人工冲正，不是这个按钮的事（DEV-PLAN 20260924 风险点 1）。
 */
export function DriverCashBoard({ onBusinessDate }: { onBusinessDate?: (date: string) => void }) {
  const [data, setData] = useState<DriverCashResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [armedDriver, setArmedDriver] = useState<string | null>(null)
  const [confirmingDriver, setConfirmingDriver] = useState<string | null>(null)
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

  async function confirm(driverName: string) {
    if (!data) return
    setConfirmingDriver(driverName)
    setError(null)
    try {
      await apiPost('/api/accounting/driver-cash/confirm', { driverName, businessDate: data.businessDate })
      setArmedDriver(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败')
    } finally {
      setConfirmingDriver(null)
    }
  }

  return (
    <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
        <span className="font-semibold text-gray-700 text-sm">💰 钱 · 司机收款确认</span>
        <span className="ml-2 text-xs text-gray-400">系统按今日订单自动算出，会计核对无误后确认——确认即入账，不可撤销</span>
      </div>

      {error && (
        <div className="px-5 py-2 bg-red-50 text-red-600 text-sm border-b border-red-100 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => load()} className="px-2 py-1 border border-red-300 rounded text-xs text-red-700 shrink-0">
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm">加载中…</div>
      ) : !data || data.drivers.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">今天还没有分配司机的订单</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {data.drivers.map(d => {
            const isArmed = armedDriver === d.driverName
            const isConfirming = confirmingDriver === d.driverName
            return (
              <div key={d.driverName} className="flex items-center gap-6 px-5 py-3 flex-wrap">
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

                <div className="ml-auto flex items-center gap-2">
                  {d.confirmed ? (
                    <span className="text-xs px-2 py-1 rounded bg-green-50 text-green-700 font-medium">
                      ✅ 已确认{d.confirmedByName ? ` · ${d.confirmedByName}` : ''}
                    </span>
                  ) : isArmed ? (
                    <>
                      <span className="text-xs text-red-600 font-medium">确定要确认吗？入账后不可撤销</span>
                      <button
                        onClick={() => confirm(d.driverName)}
                        disabled={isConfirming}
                        className="px-3 py-1 text-white rounded text-xs font-medium disabled:opacity-50"
                        style={{ background: '#dc2626' }}
                      >
                        {isConfirming ? '入账中…' : '确定入账'}
                      </button>
                      <button
                        onClick={() => setArmedDriver(null)}
                        disabled={isConfirming}
                        className="px-2 py-1 border border-gray-300 rounded text-xs text-gray-500"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setArmedDriver(d.driverName)}
                      className="px-3 py-1 text-white rounded text-xs font-medium"
                      style={{ background: ACCENT }}
                    >
                      确认
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
