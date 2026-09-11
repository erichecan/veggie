'use client'
import type { AnalysisDsl } from '@/lib/analytics-chat/dsl-schema'

export interface AggregateResult {
  mode: 'aggregate'
  rows: Array<{ key: string; name: string; value: number; qty: number }>
  total: number
  truncated: boolean
}

export interface DetailResult {
  mode: 'detail'
  columns: Array<{ key: string; labelZh: string }>
  rows: Array<Record<string, unknown>>
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
    const { columns, rows, truncated } = data.result
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] w-full rounded-lg px-3 py-2 text-sm bg-white border border-gray-200">
          <p className="font-medium" style={{ color: '#875A7B' }}>
            {isEn ? `${rows.length} rows` : `共 ${rows.length} 行明细`}
          </p>
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
          <button
            onClick={() => onSaveReport(entry.dsl)}
            className="mt-2 h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            {isEn ? '+ Save as report' : '+ 存为常用报表'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] w-full rounded-lg px-3 py-2 text-sm bg-white border border-gray-200">
        <p className="font-medium" style={{ color: '#875A7B' }}>{data.metricLabel}{isEn ? ' total: ' : '合计：'}{data.result.total}</p>
        {data.narrative && <p className="mt-1 text-gray-700">{data.narrative}</p>}
        {data.result.rows.length > 0 && (
          <table className="mt-2 w-full text-xs">
            <tbody>
              {data.result.rows.slice(0, 10).map((r) => (
                <tr key={r.key} className="border-t border-gray-100">
                  <td className="py-1 text-gray-600">{r.name}</td>
                  <td className="py-1 text-right font-medium">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.result.truncated && <p className="mt-1 text-xs text-gray-400">{isEn ? 'Showing top 500 rows only' : '仅显示前 500 行'}</p>}
        <button
          onClick={() => onSaveReport(entry.dsl)}
          className="mt-2 h-6 px-2 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
        >
          {isEn ? '+ Save as report' : '+ 存为常用报表'}
        </button>
      </div>
    </div>
  )
}
