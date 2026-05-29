'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { apiGet } from '@/lib/api'

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

const ACTION_VERB: Record<string, string> = {
  CREATE: '创建了记录',
  UPDATE: '修改了记录',
  DELETE: '删除了记录',
  LOGIN: '登录',
}

const ACTION_COLOR: Record<string, string> = {
  CREATE: '#16a34a',
  UPDATE: '#d97706',
  DELETE: '#dc2626',
  LOGIN: '#2563eb',
}

// 字段名 → 中文 label
const FIELD_LABEL: Record<string, string> = {
  // product
  name: '名称',
  internalRef: '内部参考',
  sequence: '序号',
  saleDescription: '销售描述',
  description: '描述',
  listPrice: '销售价',
  customerTaxRate: '客户税率',
  standardPrice: '成本价',
  vendorTaxRate: '供应商税率',
  weight: '重量',
  categoryId: '商品分类',
  type: '商品类型',
  commissionPrice: '佣金价格',
  status: '状态',
  canBeSold: '可售',
  // customer
  address: '地址',
  street: '街道 1',
  street2: '街道 2',
  city: '城市',
  state: '州/省',
  zip: '邮编',
  country: '国家',
  phone: '电话',
  email: '邮箱',
  vatNumber: '税号',
  paymentTerm: '付款条款',
  creditLimit: '信用额度',
  commissionRate: '佣金比率',
  commissionFixed: '固定佣金',
  pricelistId: '价格表',
  priceType: '定价模式',
  isActive: '是否启用',
  isCustomer: '是客户',
  isVendor: '是供应商',
  notes: '备注',
}

function fieldLabel(k: string): string {
  return FIELD_LABEL[k] ?? k
}

function formatVal(v: unknown): string {
  if (v == null || v === '') return '（空）'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'number') return String(v)
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
  const d = new Date(s)
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatRelative(s: string): string {
  const d = new Date(s)
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return formatAbsolute(s).slice(0, 10)
}

function dayDivider(s: string): string {
  const d = new Date(s)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
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
  const [logs, setLogs] = useState<ActionLog[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
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
    return <div className="text-xs text-gray-400 text-center py-4">加载日志中…</div>
  }

  // 没有日志时的兜底（用 fallbackCreatedAt + fallbackCreatedBy 模拟一条 "Created" 条目）
  const displayLogs: ActionLog[] = logs.length > 0
    ? logs.slice().reverse() // 让旧的在上、新的在下，时间线感更强
    : (fallbackCreatedAt
      ? [{
          id: 'fallback',
          userName: fallbackCreatedBy ?? 'Administrator',
          userEmail: '',
          action: 'CREATE',
          resource,
          resourceId,
          detail: '创建了记录',
          changes: null,
          createdAt: fallbackCreatedAt,
        }]
      : [])

  if (displayLogs.length === 0) {
    return <div className="text-xs text-gray-400 text-center py-4">暂无操作记录</div>
  }

  // 按 day bucket 分组
  const grouped: { bucket: string; items: ActionLog[] }[] = []
  for (const log of displayLogs) {
    const bucket = dayDivider(log.createdAt)
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
              const verb = ACTION_VERB[log.action] ?? log.action
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
                    {/* 第一行：谁 + 做了什么的标题 + 时间 */}
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-800">
                        {log.userName || 'Administrator'}
                      </span>
                      <span className="text-sm" style={{ color: verbColor, fontWeight: 500 }}>
                        {verb}
                      </span>
                      {log.detail && (
                        <span className="text-sm text-gray-500">— {log.detail}</span>
                      )}
                      <span
                        className="text-xs text-gray-400 ml-auto whitespace-nowrap"
                        title={formatAbsolute(log.createdAt)}
                      >
                        {formatRelative(log.createdAt)} · {formatAbsolute(log.createdAt)}
                      </span>
                    </div>
                    {/* 第二行：具体改了什么字段（可折叠） */}
                    {changeEntries.length > 0 && (() => {
                      const isExpanded = expandedIds.has(log.id)
                      return (
                        <div className="mt-1.5">
                          <button
                            onClick={() => setExpandedIds(prev => {
                              const next = new Set(prev)
                              if (next.has(log.id)) next.delete(log.id)
                              else next.add(log.id)
                              return next
                            })}
                            className="flex items-center gap-1 text-xs text-[#875A7B] hover:text-[#875A7B]/70 transition-colors"
                          >
                            <span className={`inline-block transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                            <span>{changeEntries.length} 个字段已修改</span>
                          </button>
                          {isExpanded && (
                            <ul className="mt-1.5 ml-0 space-y-1 border-l-2 border-[#875A7B]/30 pl-3 bg-gray-50/50 py-1.5 rounded-r">
                              {changeEntries.map(([field, { before, after }]) => (
                                <li
                                  key={field}
                                  className="flex items-baseline gap-2 text-xs leading-relaxed flex-wrap"
                                >
                                  <span className="text-gray-700 font-medium">
                                    {fieldLabel(field)}：
                                  </span>
                                  <span
                                    className="text-red-500 line-through max-w-[200px] truncate"
                                    title={formatVal(before)}
                                  >
                                    {formatVal(before)}
                                  </span>
                                  <span className="text-gray-400">→</span>
                                  <span
                                    className="text-green-700 font-medium max-w-[260px] truncate"
                                    title={formatVal(after)}
                                  >
                                    {formatVal(after)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })()}
                    {/* 没 diff 时如果是 UPDATE，至少提示一句 */}
                    {changeEntries.length === 0 && log.action === 'UPDATE' && !log.detail && (
                      <p className="mt-1 text-xs text-gray-400">未跟踪到字段级变更（可能是关联子表或老日志）</p>
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
          {loadingMore ? '加载中…' : `加载更多（${logs.length} / ${total}）`}
        </button>
      )}
    </div>
  )
}
