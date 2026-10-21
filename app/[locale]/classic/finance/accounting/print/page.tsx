'use client'
/**
 * 未核销回单清单打印 —— 20261021 客户要求：没回来核销的单，按日期或按司机分组打印
 * 日期 / 单号 / 客户 / 上午下午 / 司机 / 付款方式 / 金额 / 状态。
 * 筛选参数与核销管理页一致（/api/accounting/returns），默认只打未回 + 有问题。
 */
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import { formatPrintTimestamp } from '@/lib/print/trip-common'
import type { ReturnRow } from '@/lib/accounting/returns'

const STATUS_TEXT: Record<string, string> = { PENDING: '未回', ISSUE: '有问题', RETURNED: '已核销' }
const TIME_TEXT: Record<string, string> = { am: '上午', pm: '下午' }
const money = (v: number) => `€${v.toFixed(2)}`

// useSearchParams 需要 Suspense 边界，否则构建时整页退回客户端渲染并报错
export default function ReturnsPrintPage() {
  return <Suspense fallback={<div className="text-gray-400 text-sm">加载中…</div>}><ReturnsPrint /></Suspense>
}

function ReturnsPrint() {
  const sp = useSearchParams()
  const groupBy = sp.get('groupBy') === 'driver' ? 'driver' : 'date'
  const [rows, setRows] = useState<ReturnRow[] | null>(null)
  const [error, setError] = useState('')
  const [user, setUser] = useState('')

  const query = useMemo(() => {
    const p = new URLSearchParams({ tab: 'open', status: sp.get('status') || 'PENDING,ISSUE' })
    for (const k of ['from', 'to', 'driver', 'timeOfDay', 'payment', 'q']) {
      const v = sp.get(k)
      if (v) p.set(k, v)
    }
    return p.toString()
  }, [sp])

  useEffect(() => {
    apiGet<{ rows: ReturnRow[] }>(`/api/accounting/returns?${query}`)
      .then(d => {
        setRows(d.rows)
        try { setUser(JSON.parse(localStorage.getItem('veggie_user') ?? '{}').name ?? '') } catch { /* 取不到打印人不影响打印 */ }
      })
      .catch(e => setError(e instanceof Error ? e.message : '加载失败'))
  }, [query])

  const groups = useMemo(() => {
    if (!rows) return []
    const map = new Map<string, ReturnRow[]>()
    for (const r of rows) {
      const key = groupBy === 'driver' ? (r.driver || '未分配司机') : (r.deliveryDate ?? '未知日期')
      map.set(key, [...(map.get(key) ?? []), r])
    }
    const sortRows = (list: ReturnRow[]) => [...list].sort((a, b) => groupBy === 'driver'
      ? (a.deliveryDate ?? '').localeCompare(b.deliveryDate ?? '') || a.timeOfDay.localeCompare(b.timeOfDay) || (a.code ?? '').localeCompare(b.code ?? '')
      : a.timeOfDay.localeCompare(b.timeOfDay) || a.driver.localeCompare(b.driver) || (a.code ?? '').localeCompare(b.code ?? ''))
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({
      key, rows: sortRows(list), amount: list.reduce((s, r) => s + r.amount, 0),
      cash: list.filter(r => r.paymentMethod.toUpperCase() === 'CASH').reduce((s, r) => s + r.amount, 0),
    }))
  }, [rows, groupBy])

  const total = rows?.reduce((s, r) => s + r.amount, 0) ?? 0
  const filterText = [
    sp.get('from') || sp.get('to') ? `送货日期 ${sp.get('from') ?? '…'} ~ ${sp.get('to') ?? '…'}` : '全部日期',
    sp.get('driver') ? `司机 ${sp.get('driver')}` : null,
    sp.get('timeOfDay') ? TIME_TEXT[sp.get('timeOfDay')!] : null,
    sp.get('payment') ? (sp.get('payment') === 'CASH' ? '现付' : '转账') : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #returns-print, #returns-print * { visibility: visible; }
          #returns-print { position: absolute; top: 0; left: 0; width: 100%; padding: 0; }
          .no-print { display: none !important; }
          thead { display: table-header-group; }
          tbody tr { break-inside: avoid; page-break-inside: avoid; }
        }
        @page { size: A4; margin: 12mm 10mm; }
        #returns-print table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
        #returns-print th, #returns-print td { border: 1px solid #bbb; padding: 3px 6px; }
        #returns-print th { background: #f3eff5; text-align: left; }
        #returns-print .num { text-align: right; white-space: nowrap; }
      `}</style>

      <div className="no-print flex items-center justify-between mb-4">
        <div className="text-sm text-gray-600">
          未核销回单清单 · 按{groupBy === 'driver' ? '司机' : '日期'}分组 · {rows ? `${rows.length} 张` : '加载中…'}
        </div>
        <button onClick={() => window.print()} disabled={!rows}
          className="px-4 py-1.5 rounded text-sm text-white disabled:opacity-50" style={{ background: '#875A7B' }} data-testid="returns-print-btn">
          🖨 打印
        </button>
      </div>

      <div id="returns-print">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div style={{ fontSize: '15pt', fontWeight: 700 }}>未核销回单清单</div>
          <div style={{ fontSize: '9pt', color: '#555' }}>
            打印时间 {formatPrintTimestamp(new Date())}{user ? ` · 打印人 ${user}` : ''}
          </div>
        </div>
        <div style={{ fontSize: '9pt', color: '#555', marginBottom: 8 }}>
          {filterText} · 状态：未回、有问题 · 按{groupBy === 'driver' ? '司机' : '送货日期'}分组
        </div>

        {error ? <div className="text-red-600 text-sm">{error}</div>
          : !rows ? <div className="text-gray-400 text-sm">加载中…</div>
          : rows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', color: '#16a34a' }}>✅ 没有未核销的回单</div>
          : (
            <table data-testid="returns-print-table">
              <thead>
                <tr>
                  <th>送货日期</th><th>单号</th><th>客户</th><th>上午/下午</th><th>司机</th>
                  <th>付款方式</th><th className="num">含税金额</th><th>状态</th><th>已送出</th>
                </tr>
              </thead>
              {groups.map(g => (
                <tbody key={g.key}>
                  <tr>
                    <td colSpan={9} style={{ background: '#fafafa', fontWeight: 700 }}>
                      {groupBy === 'driver' ? `司机：${g.key}` : `送货日期：${g.key}`} · {g.rows.length} 张 · {money(g.amount)}
                      {g.cash > 0 ? `（其中现付 ${money(g.cash)}）` : ''}
                    </td>
                  </tr>
                  {g.rows.map(r => (
                    <tr key={r.id}>
                      <td>{r.deliveryDate ?? '—'}</td>
                      <td style={{ fontFamily: 'monospace' }}>{r.code ?? r.id.slice(-8)}</td>
                      <td>{r.restaurantName}</td>
                      <td>{TIME_TEXT[r.timeOfDay] ?? '—'}</td>
                      <td>{r.driver || '未分配'}</td>
                      <td>{r.paymentMethod.toUpperCase() === 'CASH' ? '现付' : '转账'}</td>
                      <td className="num">{money(r.amount)}</td>
                      <td>{STATUS_TEXT[r.returnStatus] ?? r.returnStatus}{r.returnIssueNote ? `：${r.returnIssueNote}` : ''}</td>
                      <td className="num">{r.daysOut} 天</td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tbody>
                <tr>
                  <td colSpan={6} style={{ fontWeight: 700 }}>合计 {rows.length} 张</td>
                  <td className="num" style={{ fontWeight: 700 }}>{money(total)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          )}
      </div>
    </>
  )
}
