'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { apiGet } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { translateLogDetail, fieldLabel as fieldLabelI18n } from '@/lib/action-log-i18n'

/**
 * Odoo Chatter 风格的活动日志：
 * 每条记录明确显示「谁 + 做了什么（含字段级 diff）+ 时间」。
 * 对接 /api/action-logs?resource=<resource>&resourceId=<id>。
 */

interface ActionLog {
  id: string
  userName: string
  userEmail: string
  action: 'LOGIN' | 'CREATE' | 'UPDATE' | 'DELETE' | string
  resource: string
  resourceId?: string
  detail?: string
  changes?: Record<string, { before: unknown; after: unknown }> | null
  createdAt: string
}

interface ApiResponse {
  logs: ActionLog[]
  total: number
  hasMore: boolean
}

const ACTION_VERB: Record<string, { zh: string; en: string }> = {
  CREATE: { zh: '创建了记录', en: 'created the record' },
  UPDATE: { zh: '修改了记录', en: 'updated the record' },
  DELETE: { zh: '删除了记录', en: 'deleted the record' },
  LOGIN: { zh: '登录', en: 'logged in' },
}

const ACTION_COLOR: Record<string, string> = {
  CREATE: '#16a34a',
  UPDATE: '#d97706',
  DELETE: '#dc2626',
  LOGIN: '#2563eb',
}

function formatVal(v: unknown, isEn: boolean): string {
  if (v == null || v === '') return isEn ? '(empty)' : '（空）'
  if (typeof v === 'boolean') return v ? (isEn ? 'Yes' : '是') : (isEn ? 'No' : '否')
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v) && v.every(x => x == null || typeof x !== 'object')) return v.length ? v.join(', ') : (isEn ? '(empty)' : '（空）')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function getInitials(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return name.slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatAbsolute(s: string): string {
  return formatDateTime(s)
}

function formatRelative(s: string, isEn: boolean): string {
  const d = new Date(s)
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60) return isEn ? 'just now' : '刚刚'
  if (diff < 3600) return isEn ? `${Math.floor(diff / 60)} min ago` : `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return isEn ? `${Math.floor(diff / 3600)} h ago` : `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return isEn ? `${Math.floor(diff / 86400)} d ago` : `${Math.floor(diff / 86400)} 天前`
  return formatAbsolute(s).slice(0, 10)
}

function dayDivider(s: string, isEn: boolean): string {
  const d = new Date(s)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) return isEn ? 'Today' : '今天'
  if (diffDays === 1) return isEn ? 'Yesterday' : '昨天'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

interface Props {
  resource: string
  resourceId?: string
  /** 创建记录的时间戳 + 创建人，作为兜底显示（API 没数据时用） */
  fallbackCreatedAt?: string
  fallbackCreatedBy?: string
  /** 是否处于"新建中"状态 */
  isNew?: boolean
}

export default function ChatterFeed({
  resource,
  resourceId,
  fallbackCreatedAt,
  fallbackCreatedBy,
  isNew = false,
}: Props) {
  const isEn = useLocale() !== routing.defaultLocale
  const [logs, setLogs] = useState<ActionLog[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  // 只要不是新建态，且有 resource 或 resourceId 之一，就会发请求
  const shouldFetch = !isNew && (!!resource || !!resourceId)
  const [loading, setLoading] = useState(shouldFetch)
  const [loadingMore, setLoadingMore] = useState(false)

  const buildUrl = useCallback((skip: number) => {
    const params = new URLSearchParams({ skip: String(skip), take: '20' })
    if (resource) params.set('resource', resource)
    if (resourceId) params.set('resourceId', resourceId)
    return `/api/action-logs?${params}`
  }, [resource, resourceId])

  useEffect(() => {
    if (!shouldFetch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false)
      return
    }
    let cancelled = false
    apiGet<ApiResponse>(buildUrl(0))
      .then(res => {
        if (cancelled) return
        setLogs(res.logs)
        setTotal(res.total)
        setHasMore(res.hasMore)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [buildUrl, shouldFetch])

  function loadMore() {
    setLoadingMore(true)
    apiGet<ApiResponse>(buildUrl(logs.length))
      .then(res => {
        setLogs(prev => [...prev, ...res.logs])
        setTotal(res.total)
        setHasMore(res.hasMore)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }

  if (isNew) {
    return (
      <div className="text-xs text-gray-400 text-center py-4">Creating a new record…</div>
    )
  }

  if (loading && logs.length === 0) {
    return <div className="text-xs text-gray-400 text-center py-4">{isEn ? 'Loading activity…' : '加载日志中…'}</div>
  }

  // 没有日志时的兜底（用 fallbackCreatedAt + fallbackCreatedBy 模拟一条 "Created" 条目）
  const displayLogs: ActionLog[] = logs.length > 0
    ? logs // API 已按 createdAt desc 排序，最新的在最上面
    : (fallbackCreatedAt
      ? [{
          id: 'fallback',
          userName: fallbackCreatedBy ?? 'Administrator',
          userEmail: '',
          action: 'CREATE',
          resource,
          resourceId,
          detail: isEn ? 'Created the record' : '创建了记录',
          changes: null,
          createdAt: fallbackCreatedAt,
        }]
      : [])

  if (displayLogs.length === 0) {
    return <div className="text-xs text-gray-400 text-center py-4">{isEn ? 'No activity yet' : '暂无操作记录'}</div>
  }

  // 按 day bucket 分组
  const grouped: { bucket: string; items: ActionLog[] }[] = []
  for (const log of displayLogs) {
    const bucket = dayDivider(log.createdAt, isEn)
    let g = grouped.find(x => x.bucket === bucket)
    if (!g) { g = { bucket, items: [] }; grouped.push(g) }
    g.items.push(log)
  }

  return (
    <div className="space-y-4">
      {grouped.map(({ bucket, items }) => (
        <div key={bucket}>
          {/* day divider */}
          <div className="flex items-center gap-3 text-xs text-gray-400 my-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="font-medium">{bucket}</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <div className="space-y-3">
            {items.map(log => {
              const initials = getInitials(log.userName)
              const verb = ACTION_VERB[log.action] ? (isEn ? ACTION_VERB[log.action].en : ACTION_VERB[log.action].zh) : log.action
              const verbColor = ACTION_COLOR[log.action] ?? '#4b5563'
              const changeEntries = log.changes ? Object.entries(log.changes) : []

              return (
                <div key={log.id} className="flex items-start gap-3">
                  {/* Who (avatar) */}
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white"
                    style={{ background: '#875A7B' }}
                    title={log.userEmail || log.userName}
                  >
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* 第一行：谁 + 做了什么 + 改了哪些字段(直接摊平展示,不用点开) + 时间 */}
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-800">
                        {log.userName || 'Administrator'}
                      </span>
                      <span className="text-sm" style={{ color: verbColor, fontWeight: 500 }}>
                        {verb}
                      </span>
                      {log.detail && (
                        <span className="text-sm text-gray-500">— {translateLogDetail(log.detail, isEn)}</span>
                      )}
                      {changeEntries.map(([field, { before, after }]) => (
                        <span key={field} className="text-xs text-gray-600 whitespace-nowrap">
                          {fieldLabelI18n(field, isEn)}{isEn ? ': ' : '：'}
                          <span className="text-red-500 line-through" title={formatVal(before, isEn)}>{formatVal(before, isEn)}</span>
                          {' → '}
                          <span className="text-green-700 font-medium" title={formatVal(after, isEn)}>{formatVal(after, isEn)}</span>
                        </span>
                      ))}
                      <span
                        className="text-xs text-gray-400 ml-auto whitespace-nowrap"
                        title={formatAbsolute(log.createdAt)}
                      >
                        {formatRelative(log.createdAt, isEn)} · {formatAbsolute(log.createdAt)}
                      </span>
                    </div>
                    {/* 没 diff 时如果是 UPDATE，至少提示一句 */}
                    {changeEntries.length === 0 && log.action === 'UPDATE' && !log.detail && (
                      <p className="mt-1 text-xs text-gray-400">{isEn ? 'No field-level changes tracked (related records or an older log entry)' : '未跟踪到字段级变更（可能是关联子表或老日志）'}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-2 text-xs text-[#875A7B] hover:underline disabled:opacity-50"
        >
          {loadingMore ? (isEn ? 'Loading…' : '加载中…') : (isEn ? `Load more (${logs.length} / ${total})` : `加载更多（${logs.length} / ${total}）`)}
        </button>
      )}
    </div>
  )
}
