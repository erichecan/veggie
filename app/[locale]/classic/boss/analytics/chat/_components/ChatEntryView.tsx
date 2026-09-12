'use client'
import type { AnalysisDsl } from '@/lib/analytics-chat/dsl-schema'
import { getDomainDef } from '@/lib/analytics-chat/domains'
import { downloadCsv } from '@/lib/csv-export'
import { escapeHtml, openPrintWindow } from '@/lib/print-export'

export interface AggregateResult {
  mode: 'aggregate'
  rows: Array<{ key: string; name: string; value: number; qty: number; value2?: number }>
  total: number
  truncated: boolean
  /** taxBasis=both 这类"两种口径都要"的查询才会有 */
  total2?: number
  secondaryLabel?: string
}

export interface DetailResult {
  mode: 'detail'
  columns: Array<{ key: string; labelZh: string }>
  rows: Array<Record<string, unknown>>
  summary: Array<{ key: string; labelZh: string; value: number }>
  truncated: boolean
}

export interface ResultData {
  /** detail 模式为 null——明细不聚合，没有"指标"这个概念 */
  metricLabel: string | null
  result: AggregateResult | DetailResult
  narrative: string | null
}

export interface AmbiguousCandidate {
  dsl: AnalysisDsl
  confirmationText: string
}

export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'confirm'; dsl: AnalysisDsl; text: string; resolved?: 'confirmed' | 'cancelled' }
  | { kind: 'ambiguous'; candidates: AmbiguousCandidate[]; resolved?: boolean }
  | { kind: 'result'; dsl: AnalysisDsl; data: ResultData }
  | { kind: 'info'; text: string }

function reportTitle(dsl: AnalysisDsl, isEn: boolean): string {
  const domainDef = getDomainDef(dsl.domain)
  const domainLabel = domainDef?.labelZh ?? dsl.domain
  const range = dsl.dateRange.from || dsl.dateRange.to
    ? `${dsl.dateRange.from ?? ''}${dsl.dateRange.from && dsl.dateRange.to ? ' ~ ' : ''}${dsl.dateRange.to ?? ''}`
    : ''
  const kind = dsl.mode === 'detail' ? (isEn ? 'Detail' : '明细') : (isEn ? 'Summary' : '汇总')
  return `${domainLabel}${isEn ? ' ' : ''}${kind}${range ? ` ${range}` : ''}`
}

function reportFilename(dsl: AnalysisDsl): string {
  const range = [dsl.dateRange.from, dsl.dateRange.to].filter(Boolean).join('_')
  return `ai-analytics-${dsl.domain}-${dsl.mode}${range ? `-${range}` : ''}`
}

function exportDetailCsv(dsl: AnalysisDsl, result: DetailResult) {
  const headers = result.columns.map((c) => c.labelZh)
  const rows = result.rows.map((r) => result.columns.map((c) => r[c.key] ?? ''))
  if (result.summary.length > 0) {
    rows.push(result.columns.map((c) => result.summary.find((s) => s.key === c.key)?.value ?? (c === result.columns[0] ? '小计' : '')))
  }
  downloadCsv(reportFilename(dsl), headers, rows)
}

function printDetail(dsl: AnalysisDsl, result: DetailResult, isEn: boolean) {
  const title = reportTitle(dsl, isEn)
  const head = result.columns.map((c) => `<th>${escapeHtml(c.labelZh)}</th>`).join('')
  const body = result.rows.map((r) =>
    `<tr>${result.columns.map((c) => `<td>${escapeHtml(String(r[c.key] ?? ''))}</td>`).join('')}</tr>`
  ).join('')
  const summaryRow = result.summary.length > 0
    ? `<tr class="total-row">${result.columns.map((c, i) => {
        const s = result.summary.find((s) => s.key === c.key)
        if (s) return `<td>${escapeHtml(String(s.value))}</td>`
        return `<td>${i === 0 ? escapeHtml(isEn ? 'Subtotal' : '小计') : ''}</td>`
      }).join('')}</tr>`
    : ''
  openPrintWindow(title, `
    <h2>${escapeHtml(title)}</h2>
    <p style="font-size:11px;color:#666;margin-bottom:12px">${isEn ? `${result.rows.length} rows` : `共 ${result.rows.length} 行`}</p>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${summaryRow}</tfoot></table>`)
}

function exportAggregateCsv(dsl: AnalysisDsl, data: ResultData, result: AggregateResult, isEn: boolean) {
  const domainDef = getDomainDef(dsl.domain)
  const dimLabel = dsl.dimension ? (domainDef?.dimensionLabelsZh[dsl.dimension] ?? dsl.dimension) : (isEn ? 'Item' : '分组')
  const headers = [dimLabel, data.metricLabel ?? (isEn ? 'Value' : '数值')]
  if (result.secondaryLabel) headers.push(result.secondaryLabel)
  const rows: unknown[][] = result.rows.map((r) => result.secondaryLabel ? [r.name, r.value, r.value2 ?? ''] : [r.name, r.value])
  rows.push(result.secondaryLabel ? [isEn ? 'Total' : '合计', result.total, result.total2] : [isEn ? 'Total' : '合计', result.total])
  downloadCsv(reportFilename(dsl), headers, rows)
}

function printAggregate(dsl: AnalysisDsl, data: ResultData, result: AggregateResult, isEn: boolean) {
  const title = reportTitle(dsl, isEn)
  const domainDef = getDomainDef(dsl.domain)
  const dimLabel = dsl.dimension ? (domainDef?.dimensionLabelsZh[dsl.dimension] ?? dsl.dimension) : (isEn ? 'Item' : '分组')
  const metricLabel = data.metricLabel ?? ''
  const secondaryHead = result.secondaryLabel ? `<th style="text-align:right">${escapeHtml(result.secondaryLabel)}</th>` : ''
  const rows = result.rows.map((r) =>
    `<tr><td>${escapeHtml(r.name)}</td><td style="text-align:right">${r.value}</td>${result.secondaryLabel ? `<td style="text-align:right">${r.value2 ?? ''}</td>` : ''}</tr>`
  ).join('')
  openPrintWindow(title, `
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr><th>${escapeHtml(dimLabel)}</th><th style="text-align:right">${escapeHtml(metricLabel)}</th>${secondaryHead}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="total-row"><td>${isEn ? 'Total' : '合计'}</td><td style="text-align:right">${result.total}</td>${result.secondaryLabel ? `<td style="text-align:right">${result.total2}</td>` : ''}</tr></tfoot>
    </table>`)
}

export function ChatEntryView({
  entry, isEn, busy, onConfirm, onCancel, onSaveReport, onPickAmbiguous,
}: {
  entry: ChatEntry
  isEn: boolean
  busy: boolean
  onConfirm: (dsl: AnalysisDsl, text: string) => void
  onCancel: () => void
  onSaveReport: (dsl: AnalysisDsl) => void
  onPickAmbiguous: (candidate: AmbiguousCandidate) => void
}) {
  if (entry.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm text-white" style={{ background: '#875A7B' }}>
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.kind === 'info') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-600">{entry.text}</div>
      </div>
    )
  }

  if (entry.kind === 'confirm') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-gray-50 border border-gray-200">
          <p className="text-gray-800">{entry.text}</p>
          {!entry.resolved && (
            <div className="mt-2 flex gap-2">
              <button
                disabled={busy}
                onClick={() => onConfirm(entry.dsl, entry.text)}
                className="h-7 px-3 text-xs rounded text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {isEn ? 'Confirm' : '确认'}
              </button>
              <button
                disabled={busy}
                onClick={onCancel}
                className="h-7 px-3 text-xs rounded border border-gray-300 text-gray-600 disabled:opacity-50"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
            </div>
          )}
          {entry.resolved === 'cancelled' && <p className="mt-1 text-xs text-gray-400">{isEn ? 'Cancelled' : '已取消'}</p>}
        </div>
      </div>
    )
  }

  if (entry.kind === 'ambiguous') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-gray-50 border border-gray-200">
          <p className="text-gray-800">
            {isEn ? 'This could mean a couple of things — which one did you mean?' : '这句话有点模糊，你是想问：'}
          </p>
          {!entry.resolved && (
            <div className="mt-2 flex flex-col gap-2">
              {entry.candidates.map((c, i) => (
                <button
                  key={i}
                  disabled={busy}
                  onClick={() => onPickAmbiguous(c)}
                  className="text-left h-auto py-1.5 px-3 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  {c.confirmationText}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // result
  const { data } = entry

  if (data.result.mode === 'detail') {
    const { columns, rows, summary, truncated } = data.result
    const detailResult: DetailResult = { mode: 'detail', columns, rows, summary, truncated }
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] w-full rounded-lg px-3 py-2 text-sm bg-white border border-gray-200">
          <p className="font-medium" style={{ color: '#875A7B' }}>
            {isEn ? `${rows.length} rows` : `共 ${rows.length} 行明细`}
          </p>
          {summary.length > 0 && (
            <p className="mt-1 text-xs text-gray-600">
              {(isEn ? 'Subtotal: ' : '小计：') + summary.map((s) => `${s.labelZh} ${s.value}`).join(isEn ? ', ' : '，')}
            </p>
          )}
          {rows.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead>
                  <tr className="border-b border-gray-200">
                    {columns.map((c) => (
                      <th key={c.key} className="py-1 pr-3 text-left text-gray-500 font-medium">{c.labelZh}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      {columns.map((c) => (
                        <td key={c.key} className="py-1 pr-3 text-gray-700">{String(r[c.key] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {truncated && <p className="mt-1 text-xs text-gray-400">{isEn ? 'Showing top 500 rows only' : '仅显示前 500 行'}</p>}
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => onSaveReport(entry.dsl)}
              className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              {isEn ? '+ Save as report' : '+ 存为常用报表'}
            </button>
            <button
              onClick={() => exportDetailCsv(entry.dsl, detailResult)}
              disabled={rows.length === 0}
              className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {isEn ? 'Download CSV' : '下载 CSV'}
            </button>
            <button
              onClick={() => printDetail(entry.dsl, detailResult, isEn)}
              disabled={rows.length === 0}
              className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {isEn ? 'Print' : '打印'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const aggResult: AggregateResult = data.result

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] w-full rounded-lg px-3 py-2 text-sm bg-white border border-gray-200">
        <p className="font-medium" style={{ color: '#875A7B' }}>
          {data.metricLabel}{isEn ? ' total: ' : '合计：'}{data.result.total}
          {aggResult.secondaryLabel && ` ／ ${aggResult.secondaryLabel}${isEn ? ' total: ' : '合计：'}${aggResult.total2}`}
        </p>
        {data.narrative && <p className="mt-1 text-gray-700">{data.narrative}</p>}
        {data.result.rows.length > 0 && (
          <table className="mt-2 w-full text-xs">
            <tbody>
              {data.result.rows.slice(0, 10).map((r) => (
                <tr key={r.key} className="border-t border-gray-100">
                  <td className="py-1 text-gray-600">{r.name}</td>
                  <td className="py-1 text-right font-medium">{r.value}</td>
                  {aggResult.secondaryLabel && <td className="py-1 text-right font-medium text-gray-500">{r.value2}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.result.truncated && <p className="mt-1 text-xs text-gray-400">{isEn ? 'Showing top 500 rows only' : '仅显示前 500 行'}</p>}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onSaveReport(entry.dsl)}
            className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            {isEn ? '+ Save as report' : '+ 存为常用报表'}
          </button>
          <button
            onClick={() => exportAggregateCsv(entry.dsl, data, aggResult, isEn)}
            className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            {isEn ? 'Download CSV' : '下载 CSV'}
          </button>
          <button
            onClick={() => printAggregate(entry.dsl, data, aggResult, isEn)}
            className="h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            {isEn ? 'Print' : '打印'}
          </button>
        </div>
      </div>
    </div>
  )
}
