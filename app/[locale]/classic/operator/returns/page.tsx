'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { Trip, ReturnItem as CanonicalReturnItem, OrderItem } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// ─── Types ─────────────────────────────────────────────────────────────────────

type ReturnStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SETTLED'
type FilterStatus = 'ALL' | ReturnStatus

interface FlatReturn extends CanonicalReturnItem {
  id: string
  tripId: string
  tripCreatedAt: string
  driverName: string
  _tripRef: Trip
  _restIdx: number
  _retIdx: number
  restaurantId: string
  restaurantName: string
  status: ReturnStatus
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING_REVIEW: '待审核',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  SETTLED: '已结算',
}

const STATUS_COLORS: Record<ReturnStatus, string> = {
  PENDING_REVIEW: 'bg-yellow-50 text-yellow-700',
  APPROVED: 'bg-green-50 text-green-700',
  REJECTED: 'bg-red-50 text-red-700',
  SETTLED: 'bg-blue-50 text-blue-700',
}

const PCT_PRESETS = [5, 10, 20, 30, 40, 50, 100]

// ─── Helpers ───────────────────────────────────────────────────────────────────

function flatten(trips: Trip[]): FlatReturn[] {
  const rows: FlatReturn[] = []
  for (const trip of trips) {
    for (let ri = 0; ri < (trip.restaurants ?? []).length; ri++) {
      const rest = trip.restaurants[ri]
      for (let ei = 0; ei < (rest.returns ?? []).length; ei++) {
        const ret = rest.returns[ei] as CanonicalReturnItem & Record<string, unknown>
        rows.push({
          ...ret,
          id: `${trip.id}-${ri}-${ei}`,
          tripId: trip.id,
          tripCreatedAt: trip.createdAt,
          driverName: (trip as unknown as Record<string, string>).driverName ?? '—',
          restaurantId: rest.restaurantId,
          restaurantName: (ret.restaurantName as string) ?? rest.restaurantName,
          status: (ret.status as ReturnStatus) ?? 'PENDING_REVIEW',
          _tripRef: trip,
          _restIdx: ri,
          _retIdx: ei,
        })
      }
    }
  }
  return rows.sort((a, b) => new Date(b.tripCreatedAt).getTime() - new Date(a.tripCreatedAt).getTime())
}

// ─── Restaurant return profile aggregation ─────────────────────────────────────

interface ReturnProfile {
  totalCount: number
  totalRefundAmount: number
  history: Array<{
    date: string
    tripId: string
    productName: string
    quantity: number
    reason?: string
    refundAmount?: number
    status: ReturnStatus
  }>
}

function buildReturnProfile(restaurantId: string, trips: Trip[]): ReturnProfile {
  const history: ReturnProfile['history'] = []
  for (const trip of trips) {
    const rest = trip.restaurants.find(r => r.restaurantId === restaurantId)
    if (!rest) continue
    for (const ret of rest.returns ?? []) {
      const r = ret as CanonicalReturnItem & Record<string, unknown>
      history.push({
        date: trip.createdAt,
        tripId: trip.id,
        productName: r.productName ?? '—',
        quantity: r.quantity ?? 0,
        reason: r.reason as string | undefined,
        refundAmount: r.refundAmount as number | undefined,
        status: (r.status as ReturnStatus) ?? 'PENDING_REVIEW',
      })
    }
  }
  history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const totalRefundAmount = history.reduce((s, h) => s + (h.refundAmount ?? 0), 0)
  return { totalCount: history.length, totalRefundAmount, history }
}

/**
 * 审核退货必须走专用接口（有状态机守卫 + 库存联动），不能直接改 Trip JSON 里的
 * returns[].status —— 通用的 PUT /api/trips/:id 现在会拒绝这种直接改法（409）。
 * 批准时必须带上 disposition：可再售(SELLABLE) 回补库存 / 报废(SCRAP) 计入损耗。
 */
async function submitReview(
  item: FlatReturn,
  action: 'approve' | 'reject',
  extra?: {
    disposition?: 'SELLABLE' | 'SCRAP'
    scrapReason?: string
    refundMode?: 'pct' | 'fixed'
    refundPct?: number
    refundAmount?: number
    refundNote?: string
  },
) {
  await apiPut(`/api/trips/${item.tripId}/returns`, {
    reviews: [{
      restaurantId: item.restaurantId,
      productId: item.productId,
      action,
      ...extra,
    }],
  })
}

// ─── Review Dialog ─────────────────────────────────────────────────────────────

interface ReviewDialogProps {
  item: FlatReturn
  allTrips: Trip[]
  onClose: () => void
  onSaved: () => void
}

function ReviewDialog({ item, allTrips, onClose, onSaved }: ReviewDialogProps) {
  const [mode, setMode] = useState<'pct' | 'fixed'>(item.refundMode ?? 'pct')
  const [pct, setPct] = useState<number>(item.refundPct ?? 0)
  const [fixed, setFixed] = useState<number>(0)
  const [reviewNote, setReviewNote] = useState((item.refundNote as string | undefined) ?? '')
  const [disposition, setDisposition] = useState<'SELLABLE' | 'SCRAP'>('SELLABLE')
  const [scrapReason, setScrapReason] = useState<'CUSTOMER_RETURN_EXPIRED' | 'CUSTOMER_RETURN_DAMAGED' | 'OTHER'>('CUSTOMER_RETURN_DAMAGED')
  const [saving, setSaving] = useState(false)
  const [ordersExpanded, setOrdersExpanded] = useState(false)
  const [profileExpanded, setProfileExpanded] = useState(false)

  const calcAmount = mode === 'pct'
    ? (((item.refundAmount ?? 0) * pct) / 100)
    : fixed

  // All returns for this restaurant in this trip (including current)
  const tripRest = item._tripRef.restaurants[item._restIdx]
  const allReturns = (tripRest.returns ?? []) as Array<CanonicalReturnItem & Record<string, unknown>>

  // All ordered items for this restaurant in this trip
  const orderedItems: OrderItem[] = tripRest.items ?? []
  const ORDERS_INITIAL_SHOW = 5
  const hiddenOrderCount = Math.max(0, orderedItems.length - ORDERS_INITIAL_SHOW)
  const visibleOrders = ordersExpanded ? orderedItems : orderedItems.slice(0, ORDERS_INITIAL_SHOW)

  // Return profile (all history)
  const profile = buildReturnProfile(item.restaurantId, allTrips)
  const historicalReturns = profile.history.filter(h => h.tripId !== item.tripId)

  async function act(action: 'approve' | 'reject') {
    setSaving(true)
    try {
      await submitReview(item, action, action === 'approve' ? {
        disposition,
        scrapReason: disposition === 'SCRAP' ? scrapReason : undefined,
        refundMode: mode,
        refundPct: mode === 'pct' ? pct : undefined,
        refundAmount: calcAmount,
        refundNote: reviewNote,
      } : {
        refundNote: reviewNote,
      })
      toast.success(action === 'approve' ? '已批准' : '已拒绝')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto" style={{ maxWidth: 700 }}>
      <DialogHeader>
        <DialogTitle style={{ color: '#875A7B' }}>
          审核退换货 — {item.restaurantName}
        </DialogTitle>
      </DialogHeader>

      {/* ── Section 1: 本次退货商品（高亮在最上方）──────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">本次退货商品</p>
        <div className="rounded-lg border border-orange-200 bg-orange-50 divide-y divide-orange-100">
          {allReturns.map((ret, i) => {
            const isCurrent = i === item._retIdx
            return (
              <div
                key={i}
                className={`px-3 py-2.5 text-sm ${isCurrent ? 'bg-orange-100' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isCurrent && (
                      <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-orange-500 mt-1" />
                    )}
                    <span className="font-medium text-gray-900 truncate">{ret.productName ?? '—'}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-right">
                    <span className="text-orange-700 font-semibold">×{ret.quantity ?? '—'}</span>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${STATUS_COLORS[(ret.status as ReturnStatus) ?? 'PENDING_REVIEW']}`}>
                      {STATUS_LABELS[(ret.status as ReturnStatus) ?? 'PENDING_REVIEW']}
                    </span>
                  </div>
                </div>
                {(ret.reason as string | undefined) && (
                  <div className="mt-1 ml-3.5 text-xs text-orange-600">原因：{ret.reason as string}</div>
                )}
                {ret.refundNote && (
                  <div className="mt-0.5 ml-3.5 text-xs text-gray-400">备注：{ret.refundNote as string}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Section 2: 本次配送的全部订单商品 ──────────────────────────────── */}
      {orderedItems.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            本次订单全部商品（共 {orderedItems.length} 件）
          </p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 divide-y divide-gray-100">
            {visibleOrders.map((item, i) => (
              <div key={i} className="px-3 py-2 text-sm flex justify-between items-center">
                <span className="text-gray-700 truncate flex-1 mr-2">{item.productName}</span>
                <div className="flex items-center gap-3 flex-shrink-0 text-right">
                  <span className="text-gray-500">×{item.quantity}</span>
                  {item.subtotal != null && (
                    <span className="text-gray-600 font-medium w-16 text-right">
                      €{item.subtotal.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hiddenOrderCount > 0 && (
            <button
              onClick={() => setOrdersExpanded(v => !v)}
              className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
            >
              {ordersExpanded
                ? '▲ 收起'
                : `▼ 展开剩余 ${hiddenOrderCount} 件商品`}
            </button>
          )}
        </div>
      )}

      {/* ── Section 3: 照片 ──────────────────────────────────────────────── */}
      {item.photo && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500 font-medium">现场照片</p>
          <img
            src={item.photo}
            alt="return-photo"
            className="w-20 h-20 object-cover rounded border border-gray-200 cursor-pointer"
            onClick={() => window.open(item.photo, '_blank')}
          />
        </div>
      )}

      {/* ── Section 3.5: 货物去向（批准时必选）──────────────────────────── */}
      {item.status === 'PENDING_REVIEW' && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">货物去向 <span className="text-red-500">*</span></p>
          <div className="flex gap-2">
            <button
              onClick={() => setDisposition('SELLABLE')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                disposition === 'SELLABLE' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-green-300'
              }`}
              style={disposition === 'SELLABLE' ? { background: '#15803d', borderColor: '#15803d' } : {}}
            >
              ✅ 可再售（回补库存）
            </button>
            <button
              onClick={() => setDisposition('SCRAP')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                disposition === 'SCRAP' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-orange-300'
              }`}
              style={disposition === 'SCRAP' ? { background: '#a3690e', borderColor: '#a3690e' } : {}}
            >
              🗑️ 报废（计入损耗）
            </button>
          </div>
          {disposition === 'SCRAP' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">报废原因</label>
              <select
                value={scrapReason}
                onChange={e => setScrapReason(e.target.value as typeof scrapReason)}
                className="border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-purple-400"
              >
                <option value="CUSTOMER_RETURN_DAMAGED">客退损坏</option>
                <option value="CUSTOMER_RETURN_EXPIRED">客退过期</option>
                <option value="OTHER">其他</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* ── Section 4: 退款方式 ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-700">退款方式</p>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('pct')}
            className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
              mode === 'pct' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
            }`}
            style={mode === 'pct' ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
          >
            按比例 %
          </button>
          <button
            onClick={() => setMode('fixed')}
            className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
              mode === 'fixed' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
            }`}
            style={mode === 'fixed' ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
          >
            固定金额 €
          </button>
        </div>

        {mode === 'pct' && (
          <div className="space-y-2">
            <div className="flex gap-1.5 flex-wrap">
              {PCT_PRESETS.map(p => (
                <button
                  key={p}
                  onClick={() => setPct(p)}
                  className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                    pct === p ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
                  }`}
                  style={pct === p ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
                >
                  {p}%
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={e => setPct(Number(e.target.value))}
                className="w-24 border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400"
              />
              <span className="text-sm text-gray-500">%</span>
              {item.refundAmount != null && (
                <span className="text-sm text-gray-400 ml-2">
                  ≈ €{((item.refundAmount * pct) / 100).toFixed(2)}
                </span>
              )}
            </div>
          </div>
        )}

        {mode === 'fixed' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">€</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={fixed}
              onChange={e => setFixed(Number(e.target.value))}
              className="w-32 border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400"
            />
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs text-gray-500 font-medium">审核备注（可选）</label>
          <textarea
            value={reviewNote}
            onChange={e => setReviewNote(e.target.value)}
            rows={2}
            placeholder="说明审核结果或特殊情况…"
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
          />
        </div>
      </div>

      {/* ── Section 5: 退货档案 ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-red-100 bg-red-50 overflow-hidden">
        <button
          onClick={() => setProfileExpanded(v => !v)}
          className="w-full px-3 py-2.5 flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-red-700">📋 退货档案</span>
            <div className="flex gap-3 text-xs text-red-600">
              <span>退货 <b>{profile.totalCount}</b> 次</span>
              <span>合计退款 <b>€{profile.totalRefundAmount.toFixed(2)}</b></span>
            </div>
          </div>
          <span className="text-xs text-red-400">{profileExpanded ? '▲' : '▼'}</span>
        </button>

        {profileExpanded && (
          <div className="border-t border-red-100">
            {profile.history.length === 0 ? (
              <p className="px-3 py-3 text-xs text-red-400">暂无退货记录</p>
            ) : (
              <div className="divide-y divide-red-100 max-h-48 overflow-y-auto">
                {profile.history.map((h, i) => (
                  <div key={i} className="px-3 py-2 text-xs flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500">{new Date(h.date).toLocaleDateString('en-GB')}</span>
                        <span className={`px-1 py-0.5 rounded text-[10px] ${STATUS_COLORS[h.status]}`}>
                          {STATUS_LABELS[h.status]}
                        </span>
                      </div>
                      <div className="text-gray-700 mt-0.5 font-medium">{h.productName} ×{h.quantity}</div>
                      {h.reason && <div className="text-red-500 mt-0.5">原因：{h.reason}</div>}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      {h.refundAmount != null && h.refundAmount > 0 && (
                        <span className="text-red-600 font-medium">-€{h.refundAmount.toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 flex-wrap">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          取消
        </Button>
        {item.status === 'PENDING_REVIEW' && (
          <>
            <Button
              onClick={() => act('reject')}
              disabled={saving}
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50"
            >
              拒绝
            </Button>
            <Button
              onClick={() => act('approve')}
              disabled={saving}
              style={{ background: '#875A7B', borderColor: '#875A7B' }}
              className="text-white hover:opacity-90"
            >
              {saving ? '保存中…' : `批准（${disposition === 'SELLABLE' ? '可再售' : '报废'}）`}
            </Button>
          </>
        )}
        {item.status === 'APPROVED' && (
          <span className="text-xs text-gray-400 self-center">结算请前往「财务 → 生成贷记单」</span>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

const FILTER_TABS: { key: FilterStatus; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_REVIEW', label: '待审核' },
  { key: 'APPROVED', label: '已批准' },
  { key: 'REJECTED', label: '已拒绝' },
  { key: 'SETTLED', label: '已结算' },
]

export default function ClassicReturnsPage() {
  const locale = useLocale()
  const en = locale !== routing.defaultLocale

  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('ALL')
  const [searchInput, setSearchInput] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reviewing, setReviewing] = useState<FlatReturn | null>(null)
  const [page, setPage] = useState(1)

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<Record<string, unknown>[]>('/api/trips')
      setTrips(data as unknown as Trip[])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const allRows = flatten(trips)

  const filtered = allRows.filter(r => {
    if (filterStatus !== 'ALL' && r.status !== filterStatus) return false
    if (searchInput) {
      const q = searchInput.toLowerCase()
      if (
        !r.restaurantName.toLowerCase().includes(q) &&
        !(r.productName ?? '').toLowerCase().includes(q) &&
        !r.driverName.toLowerCase().includes(q)
      ) return false
    }
    return true
  })

  const PAGE_SIZE = 20
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const counts: Record<FilterStatus, number> = {
    ALL: allRows.length,
    PENDING_REVIEW: allRows.filter(r => r.status === 'PENDING_REVIEW').length,
    APPROVED: allRows.filter(r => r.status === 'APPROVED').length,
    REJECTED: allRows.filter(r => r.status === 'REJECTED').length,
    SETTLED: allRows.filter(r => r.status === 'SETTLED').length,
  }

  const columns: OdooColumn[] = [
    {
      key: 'tripCreatedAt',
      label: en ? 'Date' : '时间',
      render: (v) => (
        <span className="text-xs text-gray-500">
          {v ? new Date(v as string).toLocaleDateString('en-GB') : '—'}
        </span>
      ),
    },
    {
      key: 'driverName',
      label: en ? 'Driver' : '司机',
      render: (v) => <span className="text-sm">{String(v ?? '—')}</span>,
    },
    {
      key: 'restaurantName',
      label: en ? 'Restaurant' : '餐厅',
      render: (v) => <span className="font-medium text-sm">{String(v ?? '—')}</span>,
    },
    {
      key: 'productName',
      label: en ? 'Product' : '商品',
      render: (v) => <span className="text-sm">{String(v ?? '—')}</span>,
    },
    {
      key: 'quantity',
      label: en ? 'Qty' : '数量',
      render: (v) => (
        <span className="text-sm">{v != null ? String(v) : '—'}</span>
      ),
    },
    {
      key: 'refundAmount',
      label: en ? 'Refund' : '退款金额',
      render: (v, row) => {
        const item = row as unknown as FlatReturn
        if (item.status === 'PENDING_REVIEW') return <span className="text-gray-400 text-xs">待审核</span>
        if (v == null) return <span className="text-gray-400">—</span>
        return <span className="text-sm font-medium">€{Number(v).toFixed(2)}</span>
      },
    },
    {
      key: 'status',
      label: en ? 'Status' : '状态',
      render: (v) => {
        const s = (v as ReturnStatus) ?? 'PENDING_REVIEW'
        return (
          <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLORS[s]}`}>
            {STATUS_LABELS[s]}
          </span>
        )
      },
    },
    {
      key: 'productId',
      label: en ? 'Action' : '操作',
      render: (_, row) => {
        const item = row as unknown as FlatReturn
        const canAct = item.status === 'PENDING_REVIEW' || item.status === 'APPROVED'
        return (
          <button
            onClick={e => { e.stopPropagation(); setReviewing(item) }}
            className="text-xs px-2 py-1 rounded border transition-colors"
            style={canAct
              ? { borderColor: '#875A7B', color: '#875A7B' }
              : { borderColor: '#d1d5db', color: '#6b7280' }}
          >
            {canAct ? (en ? 'Review' : '审核') : (en ? 'View' : '查看')}
          </button>
        )
      },
    },
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={[en ? 'Returns' : '退换货', en ? 'Returns Management' : '退换货管理']}
        permanentActions={[{ label: en ? 'Refresh' : '刷新', onClick: load }]}
        searchValue={searchInput}
        onSearch={v => { setSearchInput(v); setPage(1) }}
        onSearchSubmit={() => setPage(1)}
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      <div className="p-4 space-y-3">
        {/* Process flow guide */}
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wide">
            {en ? 'Returns Process' : '退换货流程'}
          </p>
          <div className="flex items-start gap-0 overflow-x-auto">
            {[
              {
                emoji: '🚚',
                step: 1,
                title: en ? 'Driver Returns' : '司机带回',
                who: en ? 'Driver' : '司机',
                whoColor: 'bg-blue-100 text-blue-700',
                desc: en ? 'Driver brings goods back from restaurant' : '司机从餐馆带回退货商品',
              },
              {
                emoji: '🔍',
                step: 2,
                title: en ? 'Salesperson Reviews' : '销售审核',
                who: en ? 'Salesperson' : '销售',
                whoColor: 'bg-purple-100 text-purple-700',
                desc: en ? 'Set refund % or fixed amount per item' : '为每件商品设定退款比例或固定金额',
              },
              {
                emoji: '✅',
                step: 3,
                title: en ? 'Approve / Reject' : '批准 / 拒绝',
                who: en ? 'Salesperson' : '销售',
                whoColor: 'bg-purple-100 text-purple-700',
                desc: en ? 'Approve or reject the return request' : '审批通过或拒绝退货申请',
              },
              {
                emoji: '💰',
                step: 4,
                title: en ? 'Finance Settles' : '会计结算',
                who: en ? 'Finance' : '会计',
                whoColor: 'bg-green-100 text-green-700',
                desc: en ? 'Finance completes the refund settlement' : '财务完成退款结算',
              },
            ].map((s, i, arr) => (
              <div key={s.step} className="flex items-start flex-shrink-0">
                <div className="flex flex-col items-center w-36">
                  <div className="flex items-center justify-center w-9 h-9 rounded-full text-lg mb-1.5" style={{ background: '#f3eff5' }}>
                    {s.emoji}
                  </div>
                  <span className="text-xs font-semibold text-gray-800 text-center leading-tight mb-1">{s.title}</span>
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium mb-1 ${s.whoColor}`}>{s.who}</span>
                  <span className="text-[10px] text-gray-500 text-center leading-snug">{s.desc}</span>
                </div>
                {i < arr.length - 1 && (
                  <div className="flex items-center mt-4 mx-1 text-gray-300 text-lg flex-shrink-0">→</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Status filter tabs */}
        <div className="flex gap-1 flex-wrap">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setFilterStatus(tab.key); setPage(1) }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
                filterStatus === tab.key ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
              }`}
              style={filterStatus === tab.key ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
            >
              {tab.label}
              {counts[tab.key] > 0 && (
                <span className={`ml-1 px-1 rounded-full text-xs ${
                  filterStatus === tab.key ? 'bg-white/30 text-white' : 'bg-gray-100 text-gray-500'
                }`}>
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        <OdooTable
          columns={columns}
          rows={pageRows as unknown as Record<string, unknown>[]}
          loading={loading}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(pageRows.map(r => r.id)))
            else setSelected(new Set())
          }}
          onSelectRow={(id, checked) => {
            setSelected(prev => {
              const next = new Set(prev)
              if (checked) next.add(id)
              else next.delete(id)
              return next
            })
          }}
          onRowClick={row => setReviewing(row as unknown as FlatReturn)}
          emptyText={en ? 'No return records' : '暂无退换货记录'}
        />
        <Pagination page={page} totalPages={Math.ceil(filtered.length / PAGE_SIZE)} onPageChange={setPage} />
      </div>

      {/* Review Dialog */}
      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null) }}>
        {reviewing && (
          <ReviewDialog
            item={reviewing}
            allTrips={trips}
            onClose={() => setReviewing(null)}
            onSaved={load}
          />
        )}
      </Dialog>
    </div>
  )
}
