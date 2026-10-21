'use client'
/**
 * 账本核对 —— 20261014（复式改造 L2）
 * 每天按明细重算一遍各类缓存余额，和存着的值比对。结果只读；差异要人判断该改哪边。
 * 逻辑在 lib/ledger-check.ts。
 */
import { useCallback, useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Button } from '@/components/ui/button'

interface CheckResult {
  key: string
  label: string
  labelEn: string
  severity: 'error' | 'info'
  diffCount: number
  amount?: number
  figures?: Record<string, number>
  samples: Array<Record<string, unknown>>
  note?: string
}

interface RunSummary {
  id: string
  trigger: string
  ok: boolean
  durationMs: number
  createdBy?: string | null
  createdAt: string
}

interface RunDetail extends RunSummary {
  results: CheckResult[]
}

const FIGURE_LABEL: Record<string, [string, string]> = {
  glReceivable: ['总账应收', 'GL receivable'],
  openInvoices: ['发票未付', 'Open invoices'],
  unappliedCredits: ['未用贷项', 'Unapplied credits'],
  difference: ['差额', 'Difference'],
  glInventory: ['总账存货', 'GL inventory'],
  stockValue: ['在手量×平均成本', 'On hand × avg cost'],
  openGrni: ['已收货未开票', 'Received not invoiced'],
  movesWithoutCost: ['无成本流水(笔)', 'Moves without cost'],
}

const fmt = (v: unknown) => {
  if (v == null) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString('en-GB')
  return String(v)
}

export default function LedgerCheckPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [current, setCurrent] = useState<RunDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const load = useCallback((id?: string) => {
    apiGet<{ runs: RunSummary[]; current: RunDetail | null }>(`/api/finance/ledger-check${id ? `?id=${id}` : ''}`)
      .then(d => { setRuns(d.runs); setCurrent(d.current) })
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
  }, [isEn])

  useEffect(() => { load() }, [load])

  // 统一补扣「已确认但从未占用库存」的订单（客户 20261015 确认），补完自动重新核对
  async function fixOrdersWithoutStock(count: number) {
    if (!window.confirm(isEn
      ? `Deduct stock for ${count} order(s) in delivery that never took stock? On hand of those products will drop accordingly.`
      : `为 ${count} 张配送中但从未扣库存的订单补扣库存？相关商品的在手量会相应减少（与确认出发时扣的一样）。`)) return
    setBusy(true)
    try {
      const r = await apiPost<{ total: number; fixed: Array<{ code: string }>; failed: Array<{ code: string; error: string }> }>(
        '/api/finance/ledger-check/orders-without-stock', {})
      if (r.failed.length) toast.error(isEn ? `${r.failed.length} failed: ${r.failed.map(f => `${f.code} ${f.error}`).join('; ')}` : `${r.failed.length} 张失败：${r.failed.map(f => `${f.code} ${f.error}`).join('；')}`)
      toast.success(isEn ? `Deducted stock for ${r.fixed.length} order(s)` : `已为 ${r.fixed.length} 张订单补扣库存`)
      await apiPost('/api/finance/ledger-check', {})
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '补扣失败'))
    } finally {
      setBusy(false)
    }
  }

  // 统一补开草稿发票（「待开票」，客户 20261021）
  async function fixUninvoiced(count: number) {
    if (!window.confirm(isEn
      ? `Create draft invoices for ${count} completed order(s) without one? Orders with no delivered quantity recorded are treated as fully delivered.`
      : `为 ${count} 张已完成但没有发票的订单补开草稿发票？实送量没记过的单按全送补上。`)) return
    setBusy(true)
    try {
      const r = await apiPost<{ total: number; fixed: Array<{ code: string }>; skipped: Array<{ code: string; reason: string }>; failed: Array<{ code: string; error: string }> }>(
        '/api/finance/ledger-check/uninvoiced-orders', {})
      if (r.failed.length) toast.error(isEn ? `${r.failed.length} failed: ${r.failed.map(f => `${f.code} ${f.error}`).join('; ')}` : `${r.failed.length} 张失败：${r.failed.map(f => `${f.code} ${f.error}`).join('；')}`)
      if (r.skipped.length) toast.warning(isEn ? `${r.skipped.length} skipped (nothing to invoice): ${r.skipped.map(x => x.code).join(', ')}` : `${r.skipped.length} 张跳过（没有可开票的行）：${r.skipped.map(x => x.code).join('、')}`)
      toast.success(isEn ? `Created ${r.fixed.length} draft invoice(s)` : `已补开 ${r.fixed.length} 张草稿发票`)
      await apiPost('/api/finance/ledger-check', {})
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '补开失败'))
    } finally {
      setBusy(false)
    }
  }

  // 统一补完成行程（波次已标记完成，20261021）
  async function fixOpenTrips(count: number) {
    if (!window.confirm(isEn
      ? `Mark ${count} trip(s) of completed waves as completed and settle driver commission?`
      : `把 ${count} 条（波次已标记完成的）行程补成已完成，并结算司机提成？`)) return
    setBusy(true)
    try {
      const r = await apiPost<{ total: number; failed: Array<{ trip: string; error: string }> }>('/api/finance/ledger-check/open-trips', {})
      if (r.failed.length) toast.error(isEn ? `${r.failed.length} commission update(s) failed` : `${r.failed.length} 条提成结算失败`)
      toast.success(isEn ? `Completed ${r.total} trip(s)` : `已补完成 ${r.total} 条行程`)
      await apiPost('/api/finance/ledger-check', {})
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '补完成失败'))
    } finally {
      setBusy(false)
    }
  }

  // 统一退回已确认（「已排波次」却不在任何司机车上的订单，20261021）
  async function fixOrphanWaves(count: number) {
    if (!window.confirm(isEn
      ? `Move ${count} order(s) back to Confirmed? They are marked wave-assigned but sit on no dated wave, so the dispatch console never shows them. Schedule them again in the dispatch console afterwards.`
      : `把 ${count} 张「已排波次」但不在任何司机车上的订单退回「已确认」？之后请到调度台按日期重新拖给司机。`)) return
    setBusy(true)
    try {
      const r = await apiPost<{ total: number; fixed: string[]; failed: Array<{ code: string; error: string }> }>('/api/finance/ledger-check/orphan-wave-orders', {})
      if (r.failed.length) toast.error(isEn ? `${r.failed.length} failed: ${r.failed.map(f => `${f.code} ${f.error}`).join('; ')}` : `${r.failed.length} 张失败：${r.failed.map(f => `${f.code} ${f.error}`).join('；')}`)
      toast.success(isEn ? `Moved ${r.fixed.length} order(s) back to Confirmed` : `已退回 ${r.fixed.length} 张订单为「已确认」`)
      await apiPost('/api/finance/ledger-check', {})
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '退回失败'))
    } finally {
      setBusy(false)
    }
  }

  async function runNow() {
    setBusy(true)
    try {
      await apiPost('/api/finance/ledger-check', {})
      toast.success(isEn ? 'Check finished' : '核对完成')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Check failed' : '核对失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{isEn ? 'Ledger Check' : '账本核对'}</h1>
          <p className="text-xs text-gray-500 mt-1">
            {isEn
              ? 'Every cached balance is recomputed from its ledger and compared. Runs daily after the backup; read-only.'
              : '每类存着的余额（发票、账单、库存……）都按明细重算一遍再比对。每天备份后自动跑一次，只读，不改数据。'}
          </p>
        </div>
        <Button disabled={busy} onClick={runNow} data-testid="ledger-run">{busy ? (isEn ? 'Checking…' : '核对中…') : (isEn ? 'Run now' : '立即核对')}</Button>
      </div>

      {!current ? (
        <div className="border border-gray-200 rounded-lg p-8 text-center text-gray-400 text-sm">
          {isEn ? 'No check has run yet. Click "Run now".' : '还没有核对记录，点「立即核对」跑第一次。'}
        </div>
      ) : (
        <>
          <div className={`rounded-lg px-4 py-3 text-sm ${current.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`} data-testid="ledger-status">
            {current.ok
              ? (isEn ? '✓ All strict checks passed' : '✓ 所有严格检查项 0 差异')
              : (isEn ? '✗ Some checks found differences' : '✗ 有检查项发现不一致')}
            <span className="ml-3 text-xs opacity-75">
              {new Date(current.createdAt).toLocaleString('en-GB')} · {current.trigger === 'AUTO' ? (isEn ? 'scheduled' : '定时') : (current.createdBy ?? (isEn ? 'manual' : '手动'))} · {current.durationMs} ms
            </span>
          </div>

          <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
            {current.results.map(r => {
              const bad = r.diffCount > 0
              const tone = !bad ? 'text-green-700' : r.severity === 'error' ? 'text-red-700' : 'text-amber-700'
              return (
                <div key={r.key} className="px-4 py-3" data-testid={`ledger-${r.key}`}>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${r.severity === 'error' ? 'bg-gray-100 text-gray-700' : 'bg-blue-50 text-blue-700'}`}>
                      {r.severity === 'error' ? (isEn ? 'strict' : '严格') : (isEn ? 'info' : '参考')}
                    </span>
                    <span className="flex-1 text-sm text-gray-900">{isEn ? r.labelEn : r.label}</span>
                    <span className={`text-sm font-semibold ${tone}`}>
                      {bad ? `${r.diffCount}${isEn ? ' item(s)' : ' 条'}` : '0'}
                      {r.amount != null && Math.abs(r.amount) > 0.005 && <span className="ml-2 font-normal">€{r.amount.toFixed(2)}</span>}
                    </span>
                    {r.samples.length > 0 && (
                      <button className="text-xs text-[#714B67] hover:underline" onClick={() => setOpen(o => ({ ...o, [r.key]: !o[r.key] }))}>
                        {open[r.key] ? (isEn ? 'Hide' : '收起') : (isEn ? 'Samples' : '样本')}
                      </button>
                    )}
                  </div>
                  {r.figures && (
                    <div className="mt-1 text-xs text-gray-600 flex flex-wrap gap-x-4">
                      {Object.entries(r.figures).map(([k, v]) => <span key={k}>{FIGURE_LABEL[k]?.[isEn ? 1 : 0] ?? k}: <b>{k === 'movesWithoutCost' ? Number(v) : `€${Number(v).toFixed(2)}`}</b></span>)}
                    </div>
                  )}
                  {r.note && <p className="mt-1 text-xs text-gray-500">{r.note}</p>}
                  {r.key === 'orders_without_stock' && r.diffCount > 0 && (
                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} data-testid="fix-orders-without-stock"
                      onClick={() => fixOrdersWithoutStock(r.diffCount)}>
                      {isEn ? `Deduct stock for all (${r.diffCount})` : `统一补扣库存（${r.diffCount} 张）`}
                    </Button>
                  )}
                  {r.key === 'completed_without_invoice' && r.diffCount > 0 && (
                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} data-testid="fix-uninvoiced-orders"
                      onClick={() => fixUninvoiced(r.diffCount)}>
                      {isEn ? `Create draft invoices (${r.diffCount})` : `统一补开草稿发票（${r.diffCount} 张）`}
                    </Button>
                  )}
                  {r.key === 'orphan_wave_orders' && r.diffCount > 0 && (
                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} data-testid="fix-orphan-waves"
                      onClick={() => fixOrphanWaves(r.diffCount)}>
                      {isEn ? `Move back to Confirmed (${r.diffCount})` : `统一退回已确认（${r.diffCount} 张）`}
                    </Button>
                  )}
                  {r.key === 'completed_wave_open_trips' && r.diffCount > 0 && (
                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} data-testid="fix-open-trips"
                      onClick={() => fixOpenTrips(r.diffCount)}>
                      {isEn ? `Complete trips (${r.diffCount})` : `统一补完成行程（${r.diffCount} 条）`}
                    </Button>
                  )}
                  {open[r.key] && r.samples.length > 0 && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="text-xs">
                        <thead className="text-gray-500">
                          <tr>{Object.keys(r.samples[0]).map(k => <th key={k} className="text-left pr-4 py-1 font-medium">{k}</th>)}</tr>
                        </thead>
                        <tbody>
                          {r.samples.map((s, i) => (
                            <tr key={i} className="border-t border-gray-100">
                              {Object.keys(r.samples[0]).map(k => <td key={k} className="pr-4 py-1 whitespace-nowrap">{fmt(s[k])}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {runs.length > 1 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'History' : '历史'}</h2>
          <div className="flex flex-wrap gap-2">
            {runs.map(r => (
              <button
                key={r.id}
                onClick={() => load(r.id)}
                className={`text-xs px-2 py-1 rounded border ${current?.id === r.id ? 'border-[#714B67]' : 'border-gray-200'} ${r.ok ? 'text-green-700' : 'text-red-700'}`}
              >
                {new Date(r.createdAt).toLocaleDateString('en-GB')} {r.ok ? '✓' : '✗'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
