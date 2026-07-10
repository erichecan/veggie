'use client'
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { Trip, TripStatus, TripRestaurant, ReturnItem } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { formatDateWithDay } from '@/lib/format-date'
import { DELIVERY_BATCHES, batchPeriod } from '@/lib/delivery-batches'

const PURPLE = '#875A7B'
const EXCEPTION_REASONS = ['品质问题', '数量错误', '客户拒收', '配送延误', '包装破损', '其他']

interface ExceptionProduct {
  productId: string
  productName: string
  quantity: number
  selected: boolean
}


const STATUS_LABEL: Record<TripStatus, string> = {
  pending:            '待出发',
  pending_assignment: '待指派司机',
  verifying:          '货物核验',
  in_progress:        '配送中',
  completed:          '已完成',
}
const STATUS_COLOR: Record<TripStatus, string> = {
  pending:            'bg-gray-100 text-gray-600',
  pending_assignment: 'bg-yellow-50 text-yellow-700',
  verifying:          'bg-yellow-50 text-yellow-700',
  in_progress:        'bg-blue-50 text-blue-700',
  completed:          'bg-green-50 text-green-700',
}

function normalizeTrip(t: Record<string, unknown>): Trip {
  return {
    ...(t as unknown as Trip),
    status: ((t.status as string) ?? 'pending').toLowerCase() as TripStatus,
    restaurants: (t.restaurants as Trip['restaurants']) ?? [],
    totalPayment: Number(t.totalPayment ?? 0),
  }
}

// Status pipeline steps
const PIPELINE: { status: TripStatus; label: string }[] = [
  { status: 'pending',            label: '待出发' },
  { status: 'in_progress',        label: '配送中' },
  { status: 'completed',          label: '已完成' },
]

export default function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expandedStops, setExpandedStops] = useState<Set<number>>(new Set())

  // 完成此站 — 实收金额
  const [stopPayments, setStopPayments] = useState<Record<string, string>>({})

  // 报告异常 modal
  const [exceptionModal, setExceptionModal] = useState<{ restId: string } | null>(null)
  const [exceptionProducts, setExceptionProducts] = useState<ExceptionProduct[]>([])
  const [exceptionReasons, setExceptionReasons] = useState<string[]>([])
  const [exceptionAction, setExceptionAction] = useState<'return' | 'exchange'>('return')

  // P1-7 货物核验
  const [showVerify, setShowVerify] = useState(false)
  const [verifyData, setVerifyData] = useState<{ restaurants: Array<{ restaurantId: string; restaurantName: string; cargoVerified: boolean; itemCount: number; discrepancies: number }> } | null>(null)
  const [verifyInputs, setVerifyInputs] = useState<Record<string, Record<string, string>>>({})
  const [submittingVerify, setSubmittingVerify] = useState(false)

  // P1-8 差异处理
  const [showDiscrepancy, setShowDiscrepancy] = useState(false)
  const [discrepancyData, setDiscrepancyData] = useState<{ discrepancies: Array<{ restaurantId: string; restaurantName: string; productId: string; productName: string; orderedQty: number; verifiedQty: number; diff: number; resolved?: boolean; resolution?: string }>; unresolvedCount: number } | null>(null)
  const [submittingDiscrepancy, setSubmittingDiscrepancy] = useState(false)

  // P1-9 退货审核
  const [returnsData, setReturnsData] = useState<{ tripId: string; totalReturns: number; pendingCount: number; approvedCount: number; rejectedCount: number; settledCount: number; returns: Array<ReturnItem & { restaurantId: string; restaurantName: string }> } | null>(null)
  const [submittingReview, setSubmittingReview] = useState(false)

  // Edit modal
  const [showEdit, setShowEdit] = useState(false)
  const [editBatch, setEditBatch] = useState('')
  const [editBatchSearch, setEditBatchSearch] = useState('')
  const [editRestaurants, setEditRestaurants] = useState<TripRestaurant[]>([])
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  function toggleStop(i: number) {
    setExpandedStops(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  function cloneTrip(): Trip {
    return JSON.parse(JSON.stringify(trip)) as Trip
  }

  async function saveStop(updated: Trip) {
    const saved = await apiPut<Record<string, unknown>>(`/api/trips/${id}`, updated)
    setTrip(normalizeTrip(saved))
  }

  async function markRestDelivered(restId: string) {
    if (!trip) return
    const r = trip.restaurants.find(r => r.restaurantId === restId)
    if (!r) return
    const payStr = stopPayments[restId] ?? ''
    if (payStr === '') { toast.error('请先填写实收货款'); return }
    const payNum = Number(payStr)
    const updated = cloneTrip()
    const ur = updated.restaurants.find(r => r.restaurantId === restId)
    if (ur) { ur.delivered = true; ur.payment = payNum }
    updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
    await saveStop(updated)
    toast.success(`${r.restaurantName} 已标记送达`)
  }

  function openExceptionModal(restId: string) {
    if (!trip) return
    const rest = trip.restaurants.find(r => r.restaurantId === restId)
    if (!rest) return
    setExceptionProducts((rest.items ?? []).map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      selected: false,
    })))
    setExceptionReasons([])
    setExceptionAction('return')
    setExceptionModal({ restId })
  }

  async function submitException() {
    if (!trip || !exceptionModal) return
    const selected = exceptionProducts.filter(p => p.selected)
    if (selected.length === 0) { toast.error('请勾选有异常的商品'); return }
    const reasonText = exceptionReasons.join('、')
    if (!reasonText.trim()) { toast.error('请填写异常原因'); return }

    setSaving(true)
    try {
      await apiPost(`/api/trips/${id}/returns`, {
        restaurantId: exceptionModal.restId,
        returns: selected.map(p => ({
          productId: p.productId,
          productName: p.productName,
          quantity: p.quantity,
          reason: reasonText,
          actionType: exceptionAction,
        })),
      })
      await load()
      setExceptionModal(null)
      toast.success('异常已记录')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交异常失败')
    } finally {
      setSaving(false)
    }
  }

  async function reviewReturn(restaurantId: string, productId: string, action: 'approve' | 'reject', disposition?: 'SELLABLE' | 'SCRAP') {
    setSubmittingReview(true)
    try {
      await apiPut(`/api/trips/${id}/returns`, {
        reviews: [{ restaurantId, productId, action, disposition }],
      })
      await load()
      toast.success(action === 'approve' ? '已批准退货' : '已拒绝退货')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '审核失败')
    } finally {
      setSubmittingReview(false)
    }
  }

  async function load() {
    try {
      const data = await apiGet<Record<string, unknown>>(`/api/trips/${id}`)
      const t = normalizeTrip(data)

      // 对没有 address 的老数据，批量补充地址
      const missingAddressIds = t.restaurants
        .filter(r => !r.address && r.restaurantId)
        .map(r => r.restaurantId)
      if (missingAddressIds.length > 0) {
        try {
          const ids = missingAddressIds.join(',')
          const customers = await apiGet<Array<{ id: string; address: string; street?: string; street2?: string; city?: string; zip?: string }>>(`/api/customers?ids=${ids}&slim=true`)
          const addrMap = new Map(customers.map(c => {
            const parts = [c.street, c.street2, c.city, c.zip].filter(Boolean)
            return [c.id, parts.length > 0 ? parts.join(', ') : c.address]
          }))
          t.restaurants = t.restaurants.map(r => ({
            ...r,
            address: r.address || addrMap.get(r.restaurantId) || '',
          }))
        } catch { /* 地址补充失败不影响主功能 */ }
      }

      setTrip(t)

      try {
        const vd = await apiGet<typeof verifyData>(`/api/trips/${id}/verify`)
        setVerifyData(vd)
      } catch { /* verification data optional */ }

      try {
        const dd = await apiGet<typeof discrepancyData>(`/api/trips/${id}/discrepancy`)
        setDiscrepancyData(dd)
      } catch { /* discrepancy data optional */ }

      try {
        const rd = await apiGet<typeof returnsData>(`/api/trips/${id}/returns`)
        setReturnsData(rd)
      } catch { /* returns data optional */ }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载行程失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function openEdit() {
    if (!trip) return
    const namePart = trip.name?.split(' · ')[0] ?? ''
    setEditBatch(DELIVERY_BATCHES.includes(namePart) ? namePart : '')
    setEditBatchSearch('')
    setEditRestaurants(trip.restaurants.map(r => ({ ...r })))
    setShowEdit(true)
  }

  async function handleSaveEdit() {
    if (!trip || saving || !editBatch) return
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        timeSlot: batchPeriod(editBatch),
        name: `${editBatch} · ${editRestaurants.length}家餐馆`,
        restaurants: editRestaurants,
      }
      const updated = await apiPut<Record<string, unknown>>(`/api/trips/${id}`, payload)
      setTrip(normalizeTrip(updated))
      setShowEdit(false)
      toast.success('行程已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleStatusChange(newStatus: string) {
    if (!trip || saving) return
    setSaving(true)
    try {
      const updated = await apiPut<Record<string, unknown>>(`/api/trips/${id}`, { status: newStatus })
      setTrip(normalizeTrip(updated))
      toast.success('状态已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setSaving(false)
    }
  }

  async function submitVerify(restaurantId: string) {
    if (!trip) return
    const inputs = verifyInputs[restaurantId]
    if (!inputs || Object.keys(inputs).length === 0) {
      toast.error('请填写核验数量')
      return
    }
    const rest = trip.restaurants.find(r => r.restaurantId === restaurantId)
    if (!rest?.items) return
    setSubmittingVerify(true)
    try {
      await apiPost(`/api/trips/${id}/verify`, {
        restaurantId,
        items: rest.items.map(item => ({
          productId: item.productId,
          verifiedQty: Number(inputs[item.productId] ?? item.quantity),
        })),
      })
      toast.success(`${rest.restaurantName} 核验完成`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '核验失败')
    } finally {
      setSubmittingVerify(false)
    }
  }

  async function submitDiscrepancyResolution(items: Array<{ restaurantId: string; productId: string; action: 'accept' | 'reject' }>) {
    if (items.length === 0) return
    setSubmittingDiscrepancy(true)
    try {
      await apiPut(`/api/trips/${id}/discrepancy`, { resolutions: items })
      toast.success('差异处理完成')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '差异处理失败')
    } finally {
      setSubmittingDiscrepancy(false)
    }
  }

  const canVerify = trip?.status === 'pending' || trip?.status === 'pending_assignment' || trip?.status === 'verifying'

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-400">加载中…</div>
    )
  }

  if (!trip) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">行程不存在</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push(`${prefix}/classic/operator/trips`)}>
          返回列表
        </Button>
      </div>
    )
  }

  const pipelineIdx = PIPELINE.findIndex(p => p.status === trip.status)
  const canEdit = trip.status === 'pending' || trip.status === 'pending_assignment'
  const canStart = trip.status === 'pending' || trip.status === 'pending_assignment'
  const canComplete = trip.status === 'in_progress'

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['配送', '配送行程', trip.name ?? trip.id.slice(0, 8)]}
        permanentActions={[
          { label: '返回列表', onClick: () => router.push(`${prefix}/classic/operator/trips`) },
        ]}
        searchValue=""
        onSearch={() => {}}
        onSearchSubmit={() => {}}
        total={0}
        page={1}
        pageSize={1}
      />

      <div className="p-4 max-w-3xl space-y-6">

        {/* ── 行程概览 card ────────────────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {trip.timeSlot && (
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    trip.timeSlot === 'AM' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'
                  }`}>
                    {trip.timeSlot === 'AM' ? '☀️ 上午 AM' : '🌙 下午 PM'}
                  </span>
                )}
                <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[trip.status]}`}>
                  {STATUS_LABEL[trip.status]}
                </span>
              </div>
              <h1 className="text-xl font-bold" style={{ color: '#875A7B' }}>
                {trip.name ?? `行程 ${trip.id.slice(0, 8)}`}
              </h1>
            </div>
            <div className="flex gap-2">
              {canVerify && (
                <Button
                  variant="outline"
                  onClick={() => setShowVerify(true)}
                  disabled={saving}
                >
                  📦 核验货物
                </Button>
              )}
              {discrepancyData && discrepancyData.unresolvedCount > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setShowDiscrepancy(true)}
                  className="border-amber-400 text-amber-700 hover:bg-amber-50"
                >
                  ⚠️ 差异处理 ({discrepancyData.unresolvedCount})
                </Button>
              )}
              {canEdit && (
                <Button
                  variant="outline"
                  onClick={openEdit}
                  disabled={saving}
                >
                  ✏️ 编辑行程
                </Button>
              )}
              {canStart && (
                <Button
                  onClick={() => handleStatusChange('IN_PROGRESS')}
                  disabled={saving}
                  className="text-white hover:opacity-90"
                  style={{ background: '#875A7B' }}
                >
                  🚚 司机出发
                </Button>
              )}
              {canComplete && (
                <Button
                  onClick={() => handleStatusChange('COMPLETED')}
                  disabled={saving}
                  className="text-white hover:opacity-90"
                  style={{ background: '#16a34a' }}
                >
                  ✅ 行程完成
                </Button>
              )}
            </div>
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm pt-2 border-t border-gray-100">
            <div>
              <span className="text-gray-400">司机</span>
              <span className="ml-2 font-medium">{trip.driverName ?? '未指定'}</span>
            </div>
            <div>
              <span className="text-gray-400">餐馆数</span>
              <span className="ml-2 font-medium">{trip.restaurants.length} 家</span>
            </div>
            {trip.departTime && (
              <div>
                <span className="text-gray-400">出发时间</span>
                <span className="ml-2 font-medium">{formatDateWithDay(trip.departTime)}</span>
              </div>
            )}
            <div>
              <span className="text-gray-400">创建日期</span>
              <span className="ml-2 font-medium">{formatDateWithDay(trip.createdAt)}</span>
            </div>
          </div>
        </div>

        {/* ── 状态时间轴 ─────────────────────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-0">
            {PIPELINE.map((step, i) => {
              const done = i < pipelineIdx
              const active = i === pipelineIdx
              return (
                <div key={step.status} className="flex items-center flex-1">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                      done ? 'bg-green-500 border-green-500 text-white' :
                      active ? 'border-purple-600 text-purple-700' :
                      'border-gray-200 text-gray-400 bg-gray-50'
                    }`} style={active ? { borderColor: '#875A7B', color: '#875A7B' } : {}}>
                      {done ? '✓' : i + 1}
                    </div>
                    <div className={`text-xs mt-1 whitespace-nowrap ${
                      active ? 'font-semibold' : done ? 'text-green-600' : 'text-gray-400'
                    }`} style={active ? { color: '#875A7B' } : {}}>
                      {step.label}
                    </div>
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-1 ${done ? 'bg-green-400' : 'bg-gray-200'}`} />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── 核验状态摘要 ─────────────────────────────────────────────────── */}
        {verifyData && verifyData.restaurants.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">货物核验状态</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {verifyData.restaurants.map(vr => (
                <div key={vr.restaurantId} className={`flex items-center justify-between p-2.5 rounded-lg text-sm ${
                  vr.cargoVerified ? 'bg-green-50' : 'bg-yellow-50'
                }`}>
                  <span className="font-medium text-gray-800">{vr.restaurantName}</span>
                  <div className="flex items-center gap-2">
                    {vr.discrepancies > 0 && (
                      <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">{vr.discrepancies} 差异</span>
                    )}
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      vr.cargoVerified ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {vr.cargoVerified ? '已核验' : '待核验'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 配送站点 ───────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">配送站点</h2>
          {trip.restaurants.length === 0 && (
            <div className="text-sm text-gray-400 py-4 text-center bg-white border border-gray-200 rounded-xl">
              暂无关联餐馆
            </div>
          )}
          {trip.restaurants.map((r: TripRestaurant, i: number) => {
            const expanded = expandedStops.has(i)
            return (
              <div key={i} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                {/* 站点头部 — 始终可见，点击展开/折叠 */}
                <button
                  onClick={() => toggleStop(i)}
                  className="w-full text-left p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-xs font-bold flex items-center justify-center shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900">{r.restaurantName}</span>
                      {r.delivered && (
                        <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">已送达</span>
                      )}
                    </div>
                    {r.address ? (
                      <p className="text-sm text-gray-500 mt-0.5 truncate">{r.address}</p>
                    ) : (
                      <p className="text-sm text-gray-300 mt-0.5 italic">暂无地址</p>
                    )}
                  </div>
                  <svg
                    className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* 展开内容 */}
                {expanded && (
                  <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
                    {/* 完整地址 */}
                    {r.address && (
                      <div className="flex gap-2 text-sm text-gray-600">
                        <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>{r.address}</span>
                      </div>
                    )}

                    {/* 关联销售单 */}
                    {r.orderIds.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1.5">关联销售单</p>
                        <div className="space-y-1">
                          {r.orderIds.map(oid => (
                            <div key={oid} className="text-sm text-gray-600 font-mono bg-gray-50 px-2 py-1 rounded">
                              {oid.slice(0, 8)}…
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 商品清单 */}
                    {r.items && r.items.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1.5">商品清单（{r.items.length} 项）</p>
                        <div className="space-y-1">
                          {r.items.map((item, j) => (
                            <div key={j} className="flex justify-between text-sm py-0.5">
                              <span className="text-gray-700">{item.productName}</span>
                              <span className="text-gray-500 shrink-0 ml-4">× {item.quantity}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 操作区：完成此站 / 报告异常 */}
                    {!r.delivered && trip.status === 'in_progress' && (
                      <div className="border-t border-gray-100 pt-3 space-y-3">
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1.5">实收货款（€）</p>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={stopPayments[r.restaurantId] ?? ''}
                            onChange={e => setStopPayments(prev => ({ ...prev, [r.restaurantId]: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                            style={{ '--tw-ring-color': PURPLE } as React.CSSProperties}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => markRestDelivered(r.restaurantId)}
                            disabled={saving}
                            className="flex-1 py-2 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-50"
                            style={{ background: '#16a34a' }}
                          >
                            完成此站
                          </button>
                          <button
                            onClick={() => openExceptionModal(r.restaurantId)}
                            disabled={saving}
                            className="flex-1 py-2 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-50"
                            style={{ background: '#dc2626' }}
                          >
                            报告异常
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 已送达标识 */}
                    {r.delivered && (
                      <div className="border-t border-gray-100 pt-3 flex items-center gap-2 text-sm text-green-700">
                        <span className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center text-xs">✓</span>
                        已送达{r.payment !== undefined ? `，实收 €${r.payment.toFixed(2)}` : ''}
                      </div>
                    )}

                    {/* 异常记录 — 优先用 API 返回的 returnsData（含 status），fallback 到 trip JSON */}
                    {(() => {
                      const apiReturns = returnsData?.returns.filter(rt => rt.restaurantId === r.restaurantId) ?? []
                      const items = apiReturns.length > 0 ? apiReturns : (r.returns ?? [])
                      if (items.length === 0) return null
                      const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
                        PENDING_REVIEW: { label: '待审核', bg: '#fef3c7', color: '#b45309' },
                        APPROVED: { label: '已批准', bg: '#dcfce7', color: '#15803d' },
                        REJECTED: { label: '已拒绝', bg: '#fee2e2', color: '#dc2626' },
                        SETTLED: { label: '已结算', bg: '#e5e7eb', color: '#374151' },
                      }
                      return (
                        <div>
                          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1.5">异常记录</p>
                          <div className="space-y-1.5">
                            {items.map((ret, j) => {
                              const badge = ret.status ? STATUS_BADGE[ret.status] : null
                              return (
                                <div key={j} className="text-sm bg-red-50 rounded-lg px-3 py-2">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                      <span className="font-medium text-gray-800">{ret.productName}</span>
                                      <span className="text-gray-500">× {ret.quantity}</span>
                                      {ret.actionType && (
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                                          {ret.actionType === 'return' ? '退货' : '换货'}
                                        </span>
                                      )}
                                      {badge && (
                                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: badge.bg, color: badge.color }}>
                                          {badge.label}
                                        </span>
                                      )}
                                    </div>
                                    {ret.status === 'PENDING_REVIEW' && (
                                      <div className="flex gap-1 ml-2 flex-shrink-0">
                                        <button
                                          onClick={() => reviewReturn(ret.restaurantId ?? r.restaurantId, ret.productId, 'approve', 'SELLABLE')}
                                          disabled={submittingReview}
                                          title="批准并回补可售库存"
                                          className="px-2 py-1 text-xs rounded font-medium text-white disabled:opacity-50"
                                          style={{ background: '#15803d' }}
                                        >
                                          批准·可再售
                                        </button>
                                        <button
                                          onClick={() => reviewReturn(ret.restaurantId ?? r.restaurantId, ret.productId, 'approve', 'SCRAP')}
                                          disabled={submittingReview}
                                          title="批准并计入报废损耗，不回补库存"
                                          className="px-2 py-1 text-xs rounded font-medium text-white disabled:opacity-50"
                                          style={{ background: '#a3690e' }}
                                        >
                                          批准·报废
                                        </button>
                                        <button
                                          onClick={() => reviewReturn(ret.restaurantId ?? r.restaurantId, ret.productId, 'reject')}
                                          disabled={submittingReview}
                                          className="px-2 py-1 text-xs rounded font-medium text-white disabled:opacity-50"
                                          style={{ background: '#dc2626' }}
                                        >
                                          拒绝
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                  {ret.reason && <p className="text-xs text-red-600 mt-1">{ret.reason}</p>}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )
          })}
        </div>

      </div>

      {/* ── 编辑行程 Dialog ──────────────────────────────────────────────── */}
      <Dialog open={showEdit} onOpenChange={open => { if (!open) setShowEdit(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: '#875A7B' }}>编辑行程</DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* 配送批次 */}
            <div>
              <p className="text-sm font-medium text-gray-600 mb-2">配送批次</p>
              <input
                type="text"
                placeholder="搜索批次…"
                value={editBatchSearch}
                onChange={e => setEditBatchSearch(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg mb-2 focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {DELIVERY_BATCHES.filter(b => b.toLowerCase().includes(editBatchSearch.toLowerCase())).map(b => (
                  <button
                    key={b}
                    onClick={() => setEditBatch(b)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border-2 transition-all ${
                      editBatch === b
                        ? 'border-purple-400 bg-[#875A7B]/20'
                        : 'border-gray-200 hover:border-purple-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">
                        {b.includes(' am ') ? 'AM' : 'PM'}
                      </span>
                      <span className="text-sm font-medium">{b}</span>
                      {editBatch === b && <span className="ml-auto text-purple-600 text-xs">✓</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* 配送地址（可编辑 + 拖拽排序） */}
            {editRestaurants.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-600 mb-2">配送地址顺序</p>
                <div className="space-y-2">
                  {editRestaurants.map((r, i) => (
                    <div
                      key={r.restaurantId + i}
                      draggable
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={e => { e.preventDefault() }}
                      onDrop={() => {
                        if (dragIndex === null || dragIndex === i) return
                        setEditRestaurants(prev => {
                          const next = [...prev]
                          const [moved] = next.splice(dragIndex, 1)
                          next.splice(i, 0, moved)
                          return next
                        })
                        setDragIndex(null)
                      }}
                      onDragEnd={() => setDragIndex(null)}
                      className={`flex items-start gap-2 p-2.5 rounded-lg border transition-all cursor-grab active:cursor-grabbing ${
                        dragIndex === i ? 'opacity-40 border-purple-300' : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      <span className="mt-2.5 text-gray-300 select-none text-base leading-none">⠿</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500 mb-1">{i + 1}. {r.restaurantName}</p>
                        <input
                          type="text"
                          value={r.address ?? ''}
                          onChange={e => {
                            const val = e.target.value
                            setEditRestaurants(prev => prev.map((x, j) => j === i ? { ...x, address: val } : x))
                          }}
                          onClick={e => e.stopPropagation()}
                          className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-purple-300"
                          placeholder="输入地址…"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEdit(false)}>取消</Button>
            <Button
              onClick={handleSaveEdit}
              disabled={saving || !editBatch}
              style={{ background: '#875A7B' }}
              className="text-white hover:opacity-90"
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── P1-7 货物核验 Dialog ──────────────────────────────────────────── */}
      <Dialog open={showVerify} onOpenChange={open => { if (!open) setShowVerify(false) }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle style={{ color: PURPLE }}>货物核验</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {trip.restaurants.map(r => {
              const vr = verifyData?.restaurants.find(v => v.restaurantId === r.restaurantId)
              const verified = vr?.cargoVerified ?? false
              return (
                <div key={r.restaurantId} className={`border rounded-lg p-3 space-y-2 ${verified ? 'border-green-200 bg-green-50/50' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{r.restaurantName}</span>
                    {verified && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">已核验</span>}
                  </div>
                  {!verified && r.items && r.items.length > 0 && (
                    <>
                      <div className="space-y-1.5">
                        {r.items.map(item => (
                          <div key={item.productId} className="flex items-center gap-2 text-sm">
                            <span className="flex-1 text-gray-700">{item.productName}</span>
                            <span className="text-gray-400 text-xs w-16 text-right">订 {item.quantity}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              placeholder={String(item.quantity)}
                              value={verifyInputs[r.restaurantId]?.[item.productId] ?? ''}
                              onChange={e => {
                                setVerifyInputs(prev => ({
                                  ...prev,
                                  [r.restaurantId]: {
                                    ...(prev[r.restaurantId] ?? {}),
                                    [item.productId]: e.target.value,
                                  },
                                }))
                              }}
                              className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-purple-300 text-right"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const prefill: Record<string, string> = {}
                            r.items?.forEach(item => { prefill[item.productId] = String(item.quantity) })
                            setVerifyInputs(prev => ({ ...prev, [r.restaurantId]: prefill }))
                          }}
                        >
                          全部一致
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => submitVerify(r.restaurantId)}
                          disabled={submittingVerify}
                          className="text-white hover:opacity-90"
                          style={{ background: PURPLE }}
                        >
                          {submittingVerify ? '提交中…' : '确认核验'}
                        </Button>
                      </div>
                    </>
                  )}
                  {verified && <p className="text-xs text-green-600">所有商品已核验完成</p>}
                </div>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVerify(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── P1-8 差异处理 Dialog ──────────────────────────────────────────── */}
      <Dialog open={showDiscrepancy} onOpenChange={open => { if (!open) setShowDiscrepancy(false) }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-amber-700">差异处理</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {(!discrepancyData || discrepancyData.discrepancies.length === 0) && (
              <p className="text-sm text-gray-400 text-center py-4">暂无差异记录</p>
            )}
            {discrepancyData?.discrepancies.filter(d => !d.resolved).map((d, i) => (
              <div key={`${d.restaurantId}-${d.productId}-${i}`} className="border border-amber-200 rounded-lg p-3 bg-amber-50/50 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-gray-800">{d.restaurantName}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-700">{d.productName}</span>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-gray-500">订 {d.orderedQty}</span>
                    <span className="text-amber-700 font-semibold">实 {d.verifiedQty}</span>
                    <span className={`font-bold ${d.diff < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {d.diff > 0 ? '+' : ''}{d.diff}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 border-green-300 text-green-700 hover:bg-green-50"
                    disabled={submittingDiscrepancy}
                    onClick={() => submitDiscrepancyResolution([{
                      restaurantId: d.restaurantId,
                      productId: d.productId,
                      action: 'accept',
                    }])}
                  >
                    接受（按实发）
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 border-red-300 text-red-700 hover:bg-red-50"
                    disabled={submittingDiscrepancy}
                    onClick={() => submitDiscrepancyResolution([{
                      restaurantId: d.restaurantId,
                      productId: d.productId,
                      action: 'reject',
                    }])}
                  >
                    驳回（按订单）
                  </Button>
                </div>
              </div>
            ))}
            {discrepancyData && discrepancyData.discrepancies.filter(d => d.resolved).length > 0 && (
              <div className="pt-2 border-t border-gray-200">
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">已处理</p>
                {discrepancyData.discrepancies.filter(d => d.resolved).map((d, i) => (
                  <div key={`resolved-${i}`} className="flex items-center justify-between text-sm py-1 text-gray-400">
                    <span>{d.restaurantName} — {d.productName}</span>
                    <span className="text-xs">{d.resolution === 'accept' ? '已接受' : '已驳回'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDiscrepancy(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 报告异常 Dialog ──────────────────────────────────────────────── */}
      <Dialog open={!!exceptionModal} onOpenChange={open => { if (!open) setExceptionModal(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: '#dc2626' }}>报告异常</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* 商品列表 */}
            <div>
              <p className="text-sm font-medium text-gray-600 mb-2">选择有异常的商品</p>
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {exceptionProducts.map((p, i) => (
                  <label key={p.productId} className="flex items-center gap-3 p-2.5 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={p.selected}
                      onChange={() => setExceptionProducts(prev => prev.map((x, j) => j === i ? { ...x, selected: !x.selected } : x))}
                      className="w-4 h-4 rounded accent-red-600"
                    />
                    <span className="flex-1 text-sm text-gray-800">{p.productName}</span>
                    <span className="text-sm text-gray-400">× {p.quantity}</span>
                  </label>
                ))}
                {exceptionProducts.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-3">该站点无商品记录</p>
                )}
              </div>
            </div>

            {/* 异常原因（多选标签） */}
            <div>
              <p className="text-sm font-medium text-gray-600 mb-2">异常原因（可多选）</p>
              <div className="flex flex-wrap gap-2">
                {EXCEPTION_REASONS.map(reason => {
                  const active = exceptionReasons.includes(reason)
                  return (
                    <button
                      key={reason}
                      onClick={() => setExceptionReasons(prev =>
                        prev.includes(reason) ? prev.filter(r => r !== reason) : [...prev, reason]
                      )}
                      className="px-3 py-1.5 rounded-full text-sm border-2 transition-all"
                      style={active
                        ? { background: '#dc2626', borderColor: '#dc2626', color: 'white' }
                        : { background: 'white', borderColor: '#e5e7eb', color: '#6b7280' }
                      }
                    >
                      {reason}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 处理方式 */}
            <div>
              <p className="text-sm font-medium text-gray-600 mb-2">处理方式</p>
              <div className="flex gap-2">
                {(['return', 'exchange'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setExceptionAction(type)}
                    className="flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-all"
                    style={exceptionAction === type
                      ? { background: PURPLE, borderColor: PURPLE, color: 'white' }
                      : { background: 'white', borderColor: '#e5e7eb', color: '#6b7280' }
                    }
                  >
                    {type === 'return' ? '退货' : '换货'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setExceptionModal(null)}>取消</Button>
            <Button
              onClick={submitException}
              disabled={saving}
              className="text-white hover:opacity-90"
              style={{ background: '#dc2626' }}
            >
              {saving ? '提交中…' : '确认提交'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
