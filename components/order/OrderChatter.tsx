'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/format-date'

function formatVal(v: unknown, isEn: boolean): string {
  if (v == null || v === '') return isEn ? '(empty)' : '（空）'
  if (typeof v === 'boolean') return v ? (isEn ? 'Yes' : '是') : (isEn ? 'No' : '否')
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface AuditLog {
  id: string
  orderId: string
  userId: string
  userName?: string | null
  action: string
  totalBefore?: number | null
  totalAfter?: number | null
  changedFields?: Record<string, unknown> | null
  createdAt: string
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const days = Math.floor(h / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

function formatTs(iso: string): string {
  return formatDateTime(iso)
}

function initials(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

function actionTitle(action: string): string {
  switch (action) {
    case 'created': return 'Sale Order created'
    case 'confirmed': return 'Quotation confirmed'
    case 'withdrawn': return 'Order withdrawn'
    case 'cancelled': return 'Order cancelled'
    case 'completed': return 'Order completed'
    case 'note': return 'Internal note'
    case 'message': return 'Message'
    default: return action.replace(/_/g, ' ')
  }
}

interface DiffEntry {
  key: string
  before: unknown
  after: unknown
}

interface LineChange {
  productName: string
  qty?: number
  unitPrice?: number
  qtyBefore?: number
  qtyAfter?: number
  priceBefore?: number
  priceAfter?: number
}

interface LineChanges {
  added?: LineChange[]
  deleted?: LineChange[]
  modified?: LineChange[]
}

function extractDiffs(log: AuditLog): { detail: string | null; diffs: DiffEntry[]; lineChanges: LineChanges | null } {
  const cf = log.changedFields ?? {}
  const detail = typeof cf.detail === 'string' ? cf.detail : null
  const diffs: DiffEntry[] = []

  // Status diff
  const status = cf.status as { before?: string; after?: string } | undefined
  if (status && typeof status === 'object' && ('before' in status || 'after' in status)) {
    diffs.push({ key: 'status', before: status.before ?? null, after: status.after ?? null })
  }

  // Amount diff
  if (log.totalBefore != null && log.totalAfter != null && log.totalBefore !== log.totalAfter) {
    diffs.push({
      key: 'amount',
      before: `€ ${Number(log.totalBefore).toFixed(2)}`,
      after: `€ ${Number(log.totalAfter).toFixed(2)}`,
    })
  }

  // Other changed fields (excluding lineChanges which we handle separately)
  for (const [k, v] of Object.entries(cf)) {
    if (k === 'detail' || k === 'status' || k === 'itemCount' || k === 'lineChanges') continue
    if (v && typeof v === 'object' && 'before' in v && 'after' in v) {
      diffs.push({
        key: k,
        before: (v as { before?: unknown }).before ?? null,
        after: (v as { after?: unknown }).after ?? null,
      })
    }
  }

  // Line changes
  const lineChanges = (cf.lineChanges as LineChanges | undefined) ?? null

  return { detail, diffs, lineChanges }
}

interface OrderChatterProps {
  orderId: string
  /** 当前订单的 status（用于判断是否显示发送按钮） */
  status?: string
}

export function OrderChatter({ orderId }: OrderChatterProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<AuditLog[]>(`/api/orders/${orderId}/audit`)
      setLogs(data)
    } catch (e) {
      console.error('[chatter load]', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [orderId])

  async function submit() {
    if (!text.trim() || submitting) return
    setSubmitting(true)
    try {
      await apiPost<AuditLog>(`/api/orders/${orderId}/audit`, { action: 'message', detail: text.trim() })
      setText('')
      await load()
      toast.success('Message sent')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Group by day
  const grouped = logs.reduce((acc, log) => {
    const key = dayLabel(log.createdAt)
    if (!acc.has(key)) acc.set(key, [])
    acc.get(key)!.push(log)
    return acc
  }, new Map<string, AuditLog[]>())

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      {/* Top bar */}
      <div className="border-b border-gray-100 pb-3">
        <span className="text-sm font-semibold text-gray-700">{isEn ? 'Activity Log' : '操作日志'}</span>
      </div>

      {/* Always-visible message compose */}
      <div className="mt-3 flex items-start gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          }}
          placeholder={isEn ? 'Send message… (Enter to send, Shift+Enter for new line)' : 'Send message…（Enter 发送，Shift+Enter 换行）'}
          className="flex-1 bg-white border border-gray-200 rounded p-2 text-sm focus:outline-none focus:border-purple-400 resize-none"
          rows={2}
        />
        <button onClick={submit} disabled={submitting || !text.trim()}
          className="px-4 py-2 text-sm text-white rounded disabled:opacity-50 shrink-0"
          style={{ background: '#875A7B' }}>
          {submitting ? '...' : 'Send'}
        </button>
      </div>

      {/* Timeline */}
      {loading && <p className="text-center text-gray-400 text-sm py-6">Loading…</p>}
      {!loading && logs.length === 0 && <p className="text-center text-gray-400 text-sm py-6">No activity yet.</p>}
      {!loading && logs.length > 0 && (
        <div className="mt-3">
          {Array.from(grouped.entries()).map(([day, dayLogs]) => (
            <div key={day}>
              {/* Day divider */}
              <div className="flex items-center my-3">
                <div className="flex-1 border-t border-gray-200" />
                <span className="px-3 text-xs text-gray-500 font-medium">{day}</span>
                <div className="flex-1 border-t border-gray-200" />
              </div>
              {/* Entries */}
              {dayLogs.map(log => {
                const { detail, diffs, lineChanges } = extractDiffs(log)
                const title = actionTitle(log.action)
                const isExpanded = expandedIds.has(log.id)
                const hasChanges = diffs.length > 0 || (lineChanges && (
                  (lineChanges.added?.length ?? 0) + (lineChanges.deleted?.length ?? 0) + (lineChanges.modified?.length ?? 0) > 0
                ))
                const changeCount = diffs.length +
                  (lineChanges?.added?.length ?? 0) +
                  (lineChanges?.deleted?.length ?? 0) +
                  (lineChanges?.modified?.length ?? 0)
                return (
                  <div key={log.id} className="flex gap-3 mb-3">
                    <div className="relative flex-shrink-0">
                      <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-gray-600">
                        {initials(log.userName)}
                      </div>
                      <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-500 border border-white" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm">
                        <span className="font-semibold" style={{ color: '#1f7a3f' }}>{log.userName ?? 'System'}</span>
                        <span className="text-gray-400 ml-2 text-xs">- {timeAgo(log.createdAt)} ({formatTs(log.createdAt)})</span>
                      </div>
                      {/* Title */}
                      {title && <div className="text-sm font-medium text-gray-700 mt-0.5">{title}</div>}
                      {/* Free-text detail */}
                      {detail && <div className="text-sm text-gray-600 mt-0.5">{detail}</div>}
                      {/* Collapsible changes */}
                      {hasChanges && (
                        <div className="mt-1.5">
                          <button
                            onClick={() => setExpandedIds(prev => {
                              const next = new Set(prev)
                              if (next.has(log.id)) next.delete(log.id)
                              else next.add(log.id)
                              return next
                            })}
                            className="flex items-center gap-1 text-xs hover:opacity-70 transition-opacity"
                            style={{ color: '#875A7B' }}
                          >
                            <span className={`inline-block transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                            <span>{changeCount} change{changeCount > 1 ? 's' : ''}</span>
                          </button>
                          {isExpanded && (
                            <div className="mt-1.5 border-l-2 pl-3 bg-gray-50/50 py-1.5 rounded-r space-y-2" style={{ borderColor: '#875A7B44' }}>
                              {/* Field-level diffs */}
                              {diffs.length > 0 && (
                                <ul className="space-y-1">
                                  {diffs.map(({ key, before, after }) => (
                                    <li key={key} className="flex items-baseline gap-2 text-xs leading-relaxed flex-wrap">
                                      <span className="text-gray-700 font-medium">{key}:</span>
                                      <span className="text-red-500 line-through max-w-[200px] truncate" title={formatVal(before, isEn)}>
                                        {formatVal(before, isEn)}
                                      </span>
                                      <span className="text-gray-400">→</span>
                                      <span className="text-green-700 font-medium max-w-[260px] truncate" title={formatVal(after, isEn)}>
                                        {formatVal(after, isEn)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {/* Line changes: added */}
                              {lineChanges?.added && lineChanges.added.length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-green-700 mb-0.5">+ Added products:</div>
                                  <ul className="space-y-0.5">
                                    {lineChanges.added.map((lc, i) => (
                                      <li key={i} className="text-xs text-green-700 pl-2">
                                        {lc.productName} — qty: {lc.qty}, price: €{Number(lc.unitPrice).toFixed(2)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {/* Line changes: deleted */}
                              {lineChanges?.deleted && lineChanges.deleted.length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-red-600 mb-0.5">− Deleted products:</div>
                                  <ul className="space-y-0.5">
                                    {lineChanges.deleted.map((lc, i) => (
                                      <li key={i} className="text-xs text-red-600 pl-2 line-through">
                                        {lc.productName} — qty: {lc.qty}, price: €{Number(lc.unitPrice).toFixed(2)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {/* Line changes: modified */}
                              {lineChanges?.modified && lineChanges.modified.length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-amber-700 mb-0.5">~ Modified products:</div>
                                  <ul className="space-y-0.5">
                                    {lineChanges.modified.map((lc, i) => (
                                      <li key={i} className="text-xs text-gray-700 pl-2">
                                        <span className="font-medium">{lc.productName}</span>
                                        {lc.qtyBefore !== lc.qtyAfter && (
                                          <span className="ml-1">
                                            qty: <span className="text-red-500 line-through">{lc.qtyBefore}</span>
                                            <span className="text-gray-400 mx-0.5">→</span>
                                            <span className="text-green-700">{lc.qtyAfter}</span>
                                          </span>
                                        )}
                                        {Math.abs((lc.priceBefore ?? 0) - (lc.priceAfter ?? 0)) > 0.001 && (
                                          <span className="ml-1">
                                            price: <span className="text-red-500 line-through">€{Number(lc.priceBefore).toFixed(2)}</span>
                                            <span className="text-gray-400 mx-0.5">→</span>
                                            <span className="text-green-700">€{Number(lc.priceAfter).toFixed(2)}</span>
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
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
