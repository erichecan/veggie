'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { downloadCsv } from '@/lib/csv-export'
import DriverReconTable from '@/components/finance/DriverReconTable'
import {
  filterReconciliationRows, reconciliationCsvRows,
  RECON_CSV_HEADERS, RECON_FILTER_LABEL,
  type ReconRow, type ReconFilter, type ReconSummary,
} from '@/lib/driver-reconciliation'

/**
 * 司机对账状态统计（台账 C10）
 *
 * 财务的收口页：谁没报账、谁等确认、谁报的对不上，一张表看全，并就地确认。
 * 确认走 C9 已有的 `PUT /api/driver-reports/daily`，本页不新开写入路径。
 */

interface Payload { from: string; to: string; rows: ReconRow[]; summary: ReconSummary }

const TABS: ReconFilter[] = ['all', 'not_submitted', 'submitted', 'confirmed', 'has_diff']

export default function DriverReconciliationPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ReconFilter>('all')
  const [acting, setActing] = useState<string | null>(null)
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)

  const load = useCallback(async (r: { from: string; to: string } | null) => {
    setLoading(true)
    try {
      const q = r ? `?from=${r.from}&to=${r.to}` : ''
      const d = await apiGet<Payload>(`/api/driver-reports/summary${q}`)
      setData(d)
      if (!r) setRange({ from: d.from, to: d.to })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(null) }, [load])

  // 筛选在客户端做：接口一次把区间内所有行返回，页签切换不再打接口，
  // 角标数字与表格内容也就不可能来自两次不同的查询
  const rows = useMemo(
    () => (data ? filterReconciliationRows(data.rows, tab) : []),
    [data, tab],
  )

  async function confirmRow(row: ReconRow) {
    const warn = row.hasDiff
      ? `\n\n⚠️ 这条有 ${row.diffs.length} 项对不上：` +
        row.diffs.map(d => `${d.label} 申报 ${d.declared} / 系统 ${d.system}`).join('；')
      : ''
    if (!confirm(`确认 ${row.driverName} ${row.date} 的当日货款？${warn}`)) return
    const key = `${row.driverId}|${row.date}`
    setActing(key)
    try {
      await apiPut('/api/driver-reports/daily', { date: row.date, driverId: row.driverId })
      toast.success('已确认')
      await load(range)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '确认失败')
    } finally {
      setActing(null)
    }
  }

  // 导出的就是屏幕上这份 rows（已筛选、已排序），不重新聚合
  function exportCsv() {
    if (!data) return
    downloadCsv(
      `司机对账_${data.from}_${data.to}${tab === 'all' ? '' : '_' + RECON_FILTER_LABEL[tab]}`,
      [...RECON_CSV_HEADERS],
      reconciliationCsvRows(rows),
    )
  }

  const s = data?.summary
  const COUNT: Record<ReconFilter, number | undefined> = {
    all: s?.total, not_submitted: s?.notSubmitted, submitted: s?.submitted,
    confirmed: s?.confirmed, has_diff: s?.hasDiff,
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">司机对账</h1>
          <p className="text-sm text-gray-500">按司机按日核对申报值与系统值，就地确认当日货款</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-gray-500">起</span>
            <input type="date" value={range?.from ?? ''} className="border rounded px-2 py-1"
                   onChange={e => setRange(r => r && { ...r, from: e.target.value })} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500">止</span>
            <input type="date" value={range?.to ?? ''} className="border rounded px-2 py-1"
                   onChange={e => setRange(r => r && { ...r, to: e.target.value })} />
          </label>
          <button onClick={() => load(range)} disabled={loading}
                  className="px-3 py-1.5 rounded bg-gray-800 text-white text-sm disabled:opacity-50">
            查询
          </button>
          <button onClick={exportCsv} disabled={!data || rows.length === 0}
                  className="px-3 py-1.5 rounded border text-sm disabled:opacity-50">
            导出 CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded text-sm border ${
                    tab === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'
                  } ${t === 'has_diff' && (COUNT.has_diff ?? 0) > 0 && tab !== t ? 'border-red-300 text-red-700' : ''}`}>
            {RECON_FILTER_LABEL[t]}
            {COUNT[t] !== undefined && <span className="ml-1 opacity-70">{COUNT[t]}</span>}
          </button>
        ))}
      </div>

      {loading
        ? <div className="border rounded p-10 text-center text-gray-500">加载中…</div>
        : <DriverReconTable rows={rows} onConfirm={confirmRow} acting={acting} />}
    </div>
  )
}
