'use client'
import type { AnalysisDsl } from '@/lib/analytics-chat/dsl-schema'

export interface ResultData {
  metricLabel: string
  result: { rows: Array<{ key: string; name: string; value: number; qty: number }>; total: number; truncated: boolean }
  narrative: string | null
}

export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'confirm'; dsl: AnalysisDsl; text: string; resolved?: 'confirmed' | 'cancelled' }
  | { kind: 'result'; dsl: AnalysisDsl; data: ResultData }
  | { kind: 'info'; text: string }

export function ChatEntryView({
  entry, isEn, busy, onConfirm, onCancel, onSaveReport,
}: {
  entry: ChatEntry
  isEn: boolean
  busy: boolean
  onConfirm: (dsl: AnalysisDsl, text: string) => void
  onCancel: () => void
  onSaveReport: (dsl: AnalysisDsl) => void
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

  // result
  const { data } = entry
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
