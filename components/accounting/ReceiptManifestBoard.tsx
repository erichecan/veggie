'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { useAbility, hasPermission } from '@/lib/permissions'

interface Entry {
  orderId: string
  orderCode: string | null
  customerName: string
  expectedAmount: number
  scannedAt?: string | null
  paperIssue: string | null
  paperReviewedAt: string | null
  lane: 'expected' | 'missing' | 'yellow' | 'red' | 'green'
  held: boolean
  reconciled: boolean
  unreported: boolean
}
interface Manifest {
  tripId: string
  driverId: string | null
  driverName: string | null
  vehiclePlate: string | null
  departedAt: string
  handedOverAt: string | null
  actualReceived: number | null
  returnPieces: number | null
  scanClosedAt: string | null
  unmatchedDiscoveries: number
  entries: Entry[]
}
interface BoardData {
  date: string
  manifests: Manifest[]
  legacyIssues: Array<{ id: string; code: string | null; restaurantName: string; returnIssueNote: string | null; returnIssueAt: string | null; createdAt: string }>
  claims: Array<{ id: string; customerName: string; productName: string; createdAt: string }>
  reviews: Array<{ id: string; productName: string; createdAt: string; status: string }>
  exceptions: Array<Pick<Manifest, 'tripId' | 'departedAt' | 'driverName' | 'handedOverAt' | 'scanClosedAt' | 'entries'> & { businessDate: string }>
}

const COLUMN = { expected: '应回', missing: '缺单', yellow: '黄色问题单', red: '红色历史单', green: '绿色正常单' }
const TONE = { expected: 'text-gray-600', missing: 'text-red-700', yellow: 'text-amber-700', red: 'text-red-700', green: 'text-green-700' }
const BUTTON = 'rounded border bg-white px-3 py-1.5 text-sm disabled:opacity-50'

export default function ReceiptManifestBoard({ salesOnly = false, onReconciled }: { salesOnly?: boolean; onReconciled?: () => void }) {
  const ability = useAbility()
  const canScan = !salesOnly && hasPermission(ability, 'finance.write_off.confirm')
  const canReview = hasPermission(ability, 'dispatch.goods_return.review')
  const [expanded, setExpanded] = useState(false)
  const [date, setDate] = useState('')
  const [data, setData] = useState<BoardData | null>(null)
  const [tripId, setTripId] = useState('')
  const [code, setCode] = useState('')
  const [issue, setIssue] = useState('')
  const [paperMarked, setPaperMarked] = useState(false)
  const [scans, setScans] = useState<Record<string, string>>({})
  const [received, setReceived] = useState('')
  const [pieces, setPieces] = useState('')
  const [paper, setPaper] = useState(false)
  const [goods, setGoods] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const manifest = data?.manifests.find(row => row.tripId === tripId)

  async function load(day: string) {
    const next = await apiGet<BoardData>(`/api/accounting/receipt-manifests${day ? `?date=${day}` : ''}`)
    setData(next)
    setDate(next.date)
    setTripId(current => next.manifests.some(row => row.tripId === current) ? current : next.manifests[0]?.tripId ?? '')
  }

  useEffect(() => {
    if (expanded) void load('').catch(error => setFeedback(error instanceof Error ? error.message : '清单加载失败'))
  }, [expanded])

  function resetInputs() {
    setScans({}); setCode(''); setIssue(''); setPaperMarked(false); setReceived(''); setPieces(''); setPaper(false); setGoods(false)
  }

  async function run(action: () => Promise<unknown>, success: string, refresh = true) {
    setBusy(true)
    setFeedback('')
    try {
      await action()
      if (refresh) await load(date)
      setFeedback(success)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '处理失败')
    } finally {
      setBusy(false)
    }
  }

  const daily = useMemo(() => {
    const rows = new Map<string, { driver: string; expected: number; returned: number; missing: number; due: number; received: number; pieces: number; unreported: number; pendingHandover: boolean }>()
    for (const trip of data?.manifests ?? []) {
      const key = trip.driverId || trip.driverName || 'unassigned'
      const row = rows.get(key) ?? { driver: trip.driverName || '未分配', expected: 0, returned: 0, missing: 0, due: 0, received: 0, pieces: 0, unreported: 0, pendingHandover: false }
      row.expected += trip.entries.length
      row.returned += trip.entries.filter(entry => !['expected', 'missing'].includes(entry.lane)).length
      row.missing += trip.entries.filter(entry => entry.lane === 'missing').length
      row.due += trip.entries.reduce((sum, entry) => sum + Number(entry.expectedAmount), 0)
      row.received += Number(trip.actualReceived ?? 0)
      row.pieces += Number(trip.returnPieces ?? 0)
      row.unreported += trip.unmatchedDiscoveries + trip.entries.filter(entry => entry.unreported).length
      row.pendingHandover ||= !trip.handedOverAt
      rows.set(key, row)
    }
    return [...rows.entries()]
  }, [data])
  if (!canScan && !canReview) return null
  const ready = manifest?.entries.filter(entry => !entry.held && !entry.reconciled && (entry.lane === 'green' || entry.lane === 'yellow')) ?? []

  return <section className="rounded border bg-white p-4 space-y-3">
    <button type="button" aria-expanded={expanded} className="font-semibold text-purple-800" onClick={() => setExpanded(value => !value)}>
      {salesOnly ? '签收单销售审核' : '司机交接、批量扫码与日结'}
    </button>
    {expanded && <>
      <div className="flex flex-wrap gap-3">
        <label>配送日期 <input type="date" className="rounded border p-1" value={date} disabled={busy} onChange={event => {
          resetInputs()
          if (event.target.value) void run(() => load(event.target.value), '', false)
        }} /></label>
        <label>司机行程 <select className="rounded border p-1" value={tripId} disabled={busy} onChange={event => { resetInputs(); setTripId(event.target.value) }}>
          <option value="">请选择</option>
          {data?.manifests.map(row => <option key={row.tripId} value={row.tripId}>{row.driverName ?? '未分配'} · {row.vehiclePlate ?? '无车牌'} · {new Date(row.departedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>)}
        </select></label>
      </div>
      {feedback && <p role="status" className="text-sm text-purple-900">{feedback}</p>}
      {manifest && <>
        {canScan && !manifest.handedOverAt && <div className="flex flex-wrap items-center gap-3 rounded bg-gray-50 p-3">
          <label><input type="checkbox" checked={paper} onChange={event => setPaper(event.target.checked)} /> 签收单已交</label>
          <label><input type="checkbox" checked={goods} onChange={event => setGoods(event.target.checked)} /> 退货实物已交接</label>
          <label>实交款 € <input type="number" min="0" step="0.01" className="w-24 rounded border p-1" value={received} onChange={event => setReceived(event.target.value)} /></label>
          <label>退货件数 <input type="number" min="0" className="w-20 rounded border p-1" value={pieces} onChange={event => setPieces(event.target.value)} /></label>
          <button className={BUTTON} disabled={busy || !paper || !goods || received === '' || pieces === ''} onClick={() => void run(() => apiPost('/api/accounting/receipt-manifests', {
            action: 'handover', tripId, paperDelivered: paper, goodsDelivered: goods, actualReceived: Number(received), returnPieces: Number(pieces),
          }), '已完成交接')}>确认三项交接</button>
        </div>}
        {canScan && <>
          <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
            event.preventDefault()
            const key = code.trim().toUpperCase()
            if (!key) return
            if (!manifest.entries.some(entry => entry.orderCode?.toUpperCase() === key)) { setFeedback(`单号 ${key} 不在此行程应回清单`); return }
            setScans(previous => ({ ...previous, [key]: issue.trim() || (paperMarked ? '纸质签收单有手写问题' : previous[key] || '') }))
            setCode(''); setIssue(''); setPaperMarked(false); setFeedback('')
          }}>
            <input aria-label="扫码单号" placeholder="扫码枪或输入单号" value={code} onChange={event => setCode(event.target.value)} className="rounded border p-1.5" />
            <label className="text-sm"><input type="checkbox" checked={paperMarked} onChange={event => setPaperMarked(event.target.checked)} /> 纸上有标记</label>
            <input aria-label="纸单手写问题" placeholder="纸上有标记时填写" value={issue} onChange={event => setIssue(event.target.value)} className="rounded border p-1.5" />
            <button className={BUTTON} disabled={busy}>加入批次</button>
            <span className="text-sm">待提交 {Object.keys(scans).length} 张</span>
          </form>
          {Object.keys(scans).length > 0 && <details className="text-sm"><summary>本批扫码明细</summary>
            {Object.entries(scans).map(([key, note]) => <div className="flex items-center gap-2" key={key}><span className="w-32">{key}</span><input aria-label={`${key} 手写问题`} placeholder="纸上有标记时填写" className="rounded border p-1" value={note} onChange={event => setScans(previous => ({ ...previous, [key]: event.target.value }))} /><button type="button" onClick={() => setScans(previous => { const next = { ...previous }; delete next[key]; return next })}>移除</button></div>)}
          </details>}
          <div className="flex flex-wrap gap-2">
            <button className={BUTTON} disabled={busy || (Boolean(manifest.scanClosedAt) && !Object.keys(scans).length)} onClick={() => void run(async () => {
              await apiPost('/api/accounting/receipt-manifests', { action: 'scan', tripId, close: true, scans: Object.entries(scans).map(([entryCode, paperIssue]) => ({ code: entryCode, paperIssue })) })
              setScans({})
            }, '扫码已入账，未扫到的应回单列入缺单。')}>{manifest.scanClosedAt ? '保存补交回单' : '完成扫码并判定缺单'}</button>
            <button className={BUTTON} disabled={busy || !ready.length} onClick={() => void run(async () => {
              const result = await apiPost<{ detail?: string }>('/api/orders/bulk', { action: 'mark_returned', status: 'RETURNED', ids: ready.map(entry => entry.orderId) })
              onReconciled?.()
              return result
            }, '核销已提交，请查看最新状态。')}>核销可处理的 {ready.length} 单</button>
          </div>
        </>}
        <div className="grid gap-2 md:grid-cols-5">
          {Object.entries(COLUMN).filter(([lane]) => !salesOnly || lane === 'yellow' || lane === 'red').map(([lane, label]) => {
            const rows = manifest.entries.filter(entry => entry.lane === lane)
            return <div key={lane} className="rounded border p-2 text-sm">
              <h3 className={`font-medium ${TONE[lane as Entry['lane']]}`}>{label}（{rows.length}）</h3>
              {rows.map(entry => <div key={entry.orderId} className="mt-1 border-t py-1">
                {entry.orderCode ?? entry.orderId} · {entry.customerName}{entry.reconciled && ' · 已核销'}
                {entry.held && <div className="text-amber-700">待人工确认 · 电话催办</div>}
                {canScan && entry.lane === 'missing' && <button className={BUTTON} disabled={busy} onClick={() => {
                  const note = window.prompt('填写人工确认签收的依据')
                  if (note?.trim()) void run(() => apiPost('/api/accounting/receipt-manifests', { action: 'manual_receipt', tripId, orderId: entry.orderId, note }), '已记录人工确认依据')
                }}>人工确认</button>}
                {entry.paperIssue && <div>{entry.paperIssue}{entry.paperReviewedAt && ' · 销售已核对'}</div>}
                {canReview && entry.paperIssue && !entry.paperReviewedAt && <button className={BUTTON} disabled={busy} onClick={() => {
                  const note = window.prompt('填写销售核对结果')
                  if (note?.trim()) void run(() => apiPost('/api/accounting/receipt-manifests', { action: 'review_paper', tripId, orderId: entry.orderId, note }), '销售核对已记录')
                }}>销售核对</button>}
              </div>)}
            </div>
          })}
        </div>
      </>}
      {canScan && daily.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr>{['司机', '应回', '实回', '缺单', '应收 €', '实收 €', '退货件数', '未报被查出'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
        <tbody>{daily.map(([key, row]) => <tr key={key} className={row.missing || row.unreported || row.pendingHandover || Math.abs(row.due - row.received) > 0.005 ? 'bg-red-50 text-red-800' : ''}>
          {[row.driver, row.expected, row.returned, row.missing, row.due.toFixed(2), row.received.toFixed(2), row.pieces, row.unreported].map((value, index) => <td key={index} className="p-2">{value}</td>)}
        </tr>)}</tbody>
      </table></div>}
      {data && <details className="text-sm"><summary className="font-medium">异常待办</summary>
        <ul className="space-y-1">
          {data.legacyIssues.map(row => <li key={row.id}>待处理 · 销售核对 · {row.code ?? row.id} {row.restaurantName} · {row.returnIssueNote} · {new Date(row.returnIssueAt ?? row.createdAt).toLocaleString()}
            {canReview && <button className={BUTTON} disabled={busy} onClick={() => {
              const note = window.prompt('填写销售核对结果')
              if (note?.trim()) void run(() => apiPost('/api/accounting/receipt-manifests', { action: 'review_legacy', orderId: row.id, note }), '销售核对已记录')
            }}>销售核对</button>}
          </li>)}
          {data.claims.map(row => <li key={row.id}>待处理 · 销售认领 · {row.customerName} {row.productName} · {new Date(row.createdAt).toLocaleString()}</li>)}
          {data.reviews.map(row => <li key={row.id}>处理中 · {row.status === 'WAREHOUSE_PENDING' ? '仓库核实' : '销售审核'} · {row.productName} · {new Date(row.createdAt).toLocaleString()}</li>)}
          {(canScan ? data.exceptions : data.exceptions.filter(row => row.entries.some(entry => entry.paperIssue && !entry.paperReviewedAt))).map(row => <li key={row.tripId}>
            <button className="text-purple-800 underline" onClick={() => {
              resetInputs()
              void run(async () => { await load(row.businessDate); setTripId(row.tripId) }, '', false)
            }}>{row.businessDate} · {row.driverName ?? '未分配'}</button>
            {canScan && !row.handedOverAt && ' · 待处理 · 司机未交接'}
            {canScan && !row.scanClosedAt && row.entries.some(entry => !entry.scannedAt) && ' · 待处理 · 会计扫码尚未结束'}
            {canScan && row.scanClosedAt && row.entries.some(entry => !entry.scannedAt) && ' · 待处理 · 缺单补交'}
            {row.entries.some(entry => entry.paperIssue && !entry.paperReviewedAt) && ' · 待处理 · 销售核对签收单'}
          </li>)}
        </ul>
      </details>}
    </>}
  </section>
}
