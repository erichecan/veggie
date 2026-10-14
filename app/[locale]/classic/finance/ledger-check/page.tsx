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
                      {Object.entries(r.figures).map(([k, v]) => <span key={k}>{FIGURE_LABEL[k]?.[isEn ? 1 : 0] ?? k}: <b>€{Number(v).toFixed(2)}</b></span>)}
                    </div>
                  )}
                  {r.note && <p className="mt-1 text-xs text-gray-500">{r.note}</p>}
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
