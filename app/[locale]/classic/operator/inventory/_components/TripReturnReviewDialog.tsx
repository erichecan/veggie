'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiPut } from '@/lib/api'
import type { Trip, ReturnItem as CanonicalReturnItem, OrderItem } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SCRAP_REASON_LABEL, SCRAP_REASON_LABEL_EN } from '@/lib/scrap-reasons'
import { round2 } from '@/lib/decimal-helpers'

/**
 * 退货/报废整合 M1：从 `operator/returns/page.tsx`（已删除）搬过来的销售/运营审核弹窗，
 * 只服务 Trip/ReturnItem 来源（司机上报）。逻辑原样保留，没有在搬迁时顺手改行为——
 * 这段是生产已验证过的既有流程（17/17 探针），改坏了就是制造新 bug。
 */

export type ReturnStatus = 'WAREHOUSE_PENDING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SETTLED'

export interface FlatReturn extends CanonicalReturnItem {
  id: string
  /** 真实的 ReturnItem.id（后端审核接口按它精确匹配）；`id` 字段被复用成行 key，
   *  两者不是一回事——历史遗留记录没有 id，这里可能是 undefined，交给后端退回 productId 匹配 */
  returnId?: string
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

export const TRIP_STATUS_LABELS_ZH: Record<ReturnStatus, string> = {
  WAREHOUSE_PENDING: '待仓库核实',
  PENDING_REVIEW: '待审核',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  SETTLED: '已结算',
}

export const TRIP_STATUS_LABELS_EN: Record<ReturnStatus, string> = {
  WAREHOUSE_PENDING: 'Pending Warehouse Check',
  PENDING_REVIEW: 'Pending Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SETTLED: 'Settled',
}

export const TRIP_STATUS_COLORS: Record<ReturnStatus, string> = {
  WAREHOUSE_PENDING: 'bg-gray-100 text-gray-500',
  PENDING_REVIEW: 'bg-yellow-50 text-yellow-700',
  APPROVED: 'bg-green-50 text-green-700',
  REJECTED: 'bg-red-50 text-red-700',
  SETTLED: 'bg-blue-50 text-blue-700',
}

const PCT_PRESETS = [5, 10, 20, 30, 40, 50, 100]

export function flattenTripReturns(trips: Trip[]): FlatReturn[] {
  const rows: FlatReturn[] = []
  for (const trip of trips) {
    for (let ri = 0; ri < (trip.restaurants ?? []).length; ri++) {
      const rest = trip.restaurants[ri]
      for (let ei = 0; ei < (rest.returns ?? []).length; ei++) {
        const ret = rest.returns[ei] as CanonicalReturnItem & Record<string, unknown>
        rows.push({
          ...ret,
          id: `${trip.id}-${ri}-${ei}`,
          returnId: ret.id,
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
    exchangeOrderId?: string
  },
) {
  await apiPut(`/api/trips/${item.tripId}/returns`, {
    reviews: [{
      restaurantId: item.restaurantId,
      productId: item.productId,
      returnId: item.returnId,
      action,
      ...extra,
    }],
  })
}

export interface TripReturnReviewDialogProps {
  item: FlatReturn
  allTrips: Trip[]
  onClose: () => void
  onSaved: () => void
  readOnly?: boolean
}

export function TripReturnReviewDialog({ item, allTrips, onClose, onSaved, readOnly }: TripReturnReviewDialogProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABELS = isEn ? TRIP_STATUS_LABELS_EN : TRIP_STATUS_LABELS_ZH
  const scrapLabels = isEn ? SCRAP_REASON_LABEL_EN : SCRAP_REASON_LABEL

  const [mode, setMode] = useState<'pct' | 'fixed'>(item.refundMode ?? 'pct')
  const [pct, setPct] = useState<number>(item.refundPct ?? 0)
  const [fixed, setFixed] = useState<number>(0)
  const [reviewNote, setReviewNote] = useState((item.refundNote as string | undefined) ?? '')
  const [exchangeOrderId, setExchangeOrderId] = useState((item.exchangeOrderId as string | undefined) ?? '')
  const [disposition, setDisposition] = useState<'SELLABLE' | 'SCRAP'>('SELLABLE')
  const [scrapReason, setScrapReason] = useState<'CUSTOMER_RETURN_EXPIRED' | 'CUSTOMER_RETURN_DAMAGED' | 'OTHER'>('CUSTOMER_RETURN_DAMAGED')
  const [saving, setSaving] = useState(false)
  const [ordersExpanded, setOrdersExpanded] = useState(false)
  const [profileExpanded, setProfileExpanded] = useState(false)

  // 退款百分比的计算基数：这条退货本身的原始货值（单价×数量），不是 item.refundAmount——
  // 那个字段只有审核通过之后才会被后端写回，首次审核时永远是 undefined，20260923 实测发现
  // 拿 undefined 当基数会让百分比退款金额恒为 0（UI 不报错，静默把 €0 发给后端）
  const baseTotal = (item.unitPrice ?? 0) * (item.quantity ?? 0)
  const calcAmount = mode === 'pct'
    ? round2((baseTotal * pct) / 100)
    : fixed

  const tripRest = item._tripRef.restaurants[item._restIdx]
  const allReturns = (tripRest.returns ?? []) as Array<CanonicalReturnItem & Record<string, unknown>>

  const orderedItems: OrderItem[] = tripRest.items ?? []
  const ORDERS_INITIAL_SHOW = 5
  const hiddenOrderCount = Math.max(0, orderedItems.length - ORDERS_INITIAL_SHOW)
  const visibleOrders = ordersExpanded ? orderedItems : orderedItems.slice(0, ORDERS_INITIAL_SHOW)

  const profile = buildReturnProfile(item.restaurantId, allTrips)

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
        exchangeOrderId: item.actionType === 'exchange' ? (exchangeOrderId.trim() || undefined) : undefined,
      } : {
        refundNote: reviewNote,
      })
      toast.success(action === 'approve'
        ? (isEn ? 'Return approved' : '已批准')
        : (isEn ? 'Return rejected' : '已拒绝'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Review failed' : '操作失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto" style={{ maxWidth: 700 }}>
      <DialogHeader>
        <DialogTitle style={{ color: '#875A7B' }}>
          {isEn ? 'Review Return/Exchange' : '审核退换货'} — {item.restaurantName}
          <span className="ml-2 text-xs font-normal text-blue-500">{isEn ? '🚚 Driver-reported' : '🚚 司机上报'}</span>
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{isEn ? 'Items in This Return' : '本次退货商品'}</p>
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
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${TRIP_STATUS_COLORS[(ret.status as ReturnStatus) ?? 'PENDING_REVIEW']}`}>
                      {STATUS_LABELS[(ret.status as ReturnStatus) ?? 'PENDING_REVIEW']}
                    </span>
                  </div>
                </div>
                {(ret.reason as string | undefined) && (
                  <div className="mt-1 ml-3.5 text-xs text-orange-600">{isEn ? 'Reason: ' : '原因：'}{ret.reason as string}</div>
                )}
                {(ret.lateReportNote as string | undefined) && (
                  <div className="mt-0.5 ml-3.5 text-xs text-amber-700">{isEn ? 'Late report — why: ' : '补报原因：'}{ret.lateReportNote as string}</div>
                )}
                {ret.refundNote && (
                  <div className="mt-0.5 ml-3.5 text-xs text-gray-400">{isEn ? 'Note: ' : '备注：'}{ret.refundNote as string}</div>
                )}
                {(ret.exchangeOrderId as string | undefined) && (
                  <div className="mt-0.5 ml-3.5 text-xs text-blue-500">{isEn ? 'Exchange order: ' : '换货新单号：'}{ret.exchangeOrderId as string}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {orderedItems.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {isEn ? `All Items in This Delivery (${orderedItems.length} items)` : `本次订单全部商品（共 ${orderedItems.length} 件）`}
          </p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 divide-y divide-gray-100">
            {visibleOrders.map((o, i) => (
              <div key={i} className="px-3 py-2 text-sm flex justify-between items-center">
                <span className="text-gray-700 truncate flex-1 mr-2">{o.productName}</span>
                <div className="flex items-center gap-3 flex-shrink-0 text-right">
                  <span className="text-gray-500">×{o.quantity}</span>
                  {o.subtotal != null && (
                    <span className="text-gray-600 font-medium w-16 text-right">
                      €{o.subtotal.toFixed(2)}
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
                ? (isEn ? '▲ Collapse' : '▲ 收起')
                : (isEn ? `▼ Show ${hiddenOrderCount} more items` : `▼ 展开剩余 ${hiddenOrderCount} 件商品`)}
            </button>
          )}
        </div>
      )}

      {item.photo && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500 font-medium">{isEn ? 'Photo Evidence' : '现场照片'}</p>
          <img
            src={item.photo}
            alt="return-photo"
            className="w-20 h-20 object-cover rounded border border-gray-200 cursor-pointer"
            onClick={() => window.open(item.photo, '_blank')}
          />
        </div>
      )}

      {item.actionType === 'exchange' && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-700">{isEn ? 'Linked Exchange Order' : '关联的换货新单号'}</p>
          <input
            type="text"
            value={exchangeOrderId}
            onChange={e => setExchangeOrderId(e.target.value)}
            placeholder={isEn ? 'Order code of the newly created replacement order' : '新开的换货订单单号'}
            disabled={item.status !== 'PENDING_REVIEW'}
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 disabled:bg-gray-50 disabled:text-gray-400"
          />
          <p className="text-xs text-gray-400">{isEn ? 'Only recorded as a reference — not validated against a real order' : '仅作记录关联，不校验单号真实性'}</p>
        </div>
      )}

      {item.status === 'PENDING_REVIEW' && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">{isEn ? 'Disposition' : '货物去向'} <span className="text-red-500">*</span></p>
          <div className="flex gap-2">
            <button
              onClick={() => setDisposition('SELLABLE')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                disposition === 'SELLABLE' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-green-300'
              }`}
              style={disposition === 'SELLABLE' ? { background: '#15803d', borderColor: '#15803d' } : {}}
            >
              {isEn ? '✅ Sellable (Restock)' : '✅ 可再售（回补库存）'}
            </button>
            <button
              onClick={() => setDisposition('SCRAP')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                disposition === 'SCRAP' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-orange-300'
              }`}
              style={disposition === 'SCRAP' ? { background: '#a3690e', borderColor: '#a3690e' } : {}}
            >
              {isEn ? '🗑️ Scrap (Record as Loss)' : '🗑️ 报废（计入损耗）'}
            </button>
          </div>
          {disposition === 'SCRAP' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">{isEn ? 'Scrap Reason' : '报废原因'}</label>
              <select
                value={scrapReason}
                onChange={e => setScrapReason(e.target.value as typeof scrapReason)}
                className="border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-purple-400"
              >
                <option value="CUSTOMER_RETURN_DAMAGED">{scrapLabels.CUSTOMER_RETURN_DAMAGED}</option>
                <option value="CUSTOMER_RETURN_EXPIRED">{scrapLabels.CUSTOMER_RETURN_EXPIRED}</option>
                <option value="OTHER">{scrapLabels.OTHER}</option>
              </select>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-700">{isEn ? 'Refund Method' : '退款方式'}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('pct')}
            className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
              mode === 'pct' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
            }`}
            style={mode === 'pct' ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
          >
            {isEn ? 'Percentage %' : '按比例 %'}
          </button>
          <button
            onClick={() => setMode('fixed')}
            className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
              mode === 'fixed' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-purple-300'
            }`}
            style={mode === 'fixed' ? { background: '#875A7B', borderColor: '#875A7B' } : {}}
          >
            {isEn ? 'Fixed Amount €' : '固定金额 €'}
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
              {baseTotal > 0 && (
                <span className="text-sm text-gray-400 ml-2">
                  ≈ €{round2((baseTotal * pct) / 100).toFixed(2)}
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
          <label className="text-xs text-gray-500 font-medium">{isEn ? 'Review Note (optional)' : '审核备注（可选）'}</label>
          <textarea
            value={reviewNote}
            onChange={e => setReviewNote(e.target.value)}
            rows={2}
            placeholder={isEn ? 'Describe review outcome or special circumstances…' : '说明审核结果或特殊情况…'}
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
          />
        </div>
      </div>

      <div className="rounded-lg border border-red-100 bg-red-50 overflow-hidden">
        <button
          onClick={() => setProfileExpanded(v => !v)}
          className="w-full px-3 py-2.5 flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-red-700">{isEn ? '📋 Return Profile' : '📋 退货档案'}</span>
            <div className="flex gap-3 text-xs text-red-600">
              {isEn ? (
                <span><b>{profile.totalCount}</b> returns</span>
              ) : (
                <span>退货 <b>{profile.totalCount}</b> 次</span>
              )}
              {isEn ? (
                <span>Total refunded <b>€{profile.totalRefundAmount.toFixed(2)}</b></span>
              ) : (
                <span>合计退款 <b>€{profile.totalRefundAmount.toFixed(2)}</b></span>
              )}
            </div>
          </div>
          <span className="text-xs text-red-400">{profileExpanded ? '▲' : '▼'}</span>
        </button>

        {profileExpanded && (
          <div className="border-t border-red-100">
            {profile.history.length === 0 ? (
              <p className="px-3 py-3 text-xs text-red-400">{isEn ? 'No return history' : '暂无退货记录'}</p>
            ) : (
              <div className="divide-y divide-red-100 max-h-48 overflow-y-auto">
                {profile.history.map((h, i) => (
                  <div key={i} className="px-3 py-2 text-xs flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500">{new Date(h.date).toLocaleDateString('en-GB')}</span>
                        <span className={`px-1 py-0.5 rounded text-[10px] ${TRIP_STATUS_COLORS[h.status]}`}>
                          {STATUS_LABELS[h.status]}
                        </span>
                      </div>
                      <div className="text-gray-700 mt-0.5 font-medium">{h.productName} ×{h.quantity}</div>
                      {h.reason && <div className="text-red-500 mt-0.5">{isEn ? 'Reason: ' : '原因：'}{h.reason}</div>}
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
          {isEn ? 'Cancel' : '取消'}
        </Button>
        {item.status === 'PENDING_REVIEW' && readOnly && (
          <span className="text-xs text-gray-400 self-center">
            {isEn ? 'View only — your role cannot review this' : '仅查看——你的角色没有审核权限'}
          </span>
        )}
        {item.status === 'PENDING_REVIEW' && !readOnly && (
          <>
            <Button
              onClick={() => act('reject')}
              disabled={saving}
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50"
            >
              {isEn ? 'Reject' : '拒绝'}
            </Button>
            <Button
              onClick={() => act('approve')}
              disabled={saving}
              style={{ background: '#875A7B', borderColor: '#875A7B' }}
              className="text-white hover:opacity-90"
            >
              {saving
                ? (isEn ? 'Saving…' : '保存中…')
                : (isEn
                    ? `Approve — ${disposition === 'SELLABLE' ? 'Resellable' : 'Scrap'}`
                    : `批准（${disposition === 'SELLABLE' ? '可再售' : '报废'}）`)}
            </Button>
          </>
        )}
        {item.status === 'APPROVED' && (
          <span className="text-xs text-gray-400 self-center">
            {isEn ? 'To settle, go to Finance → Generate Credit Note' : '结算请前往「财务 → 生成贷记单」'}
          </span>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

export function TripReturnReviewDialogWrapper({ item, allTrips, onClose, onSaved, readOnly }: TripReturnReviewDialogProps) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <TripReturnReviewDialog item={item} allTrips={allTrips} onClose={onClose} onSaved={onSaved} readOnly={readOnly} />
    </Dialog>
  )
}
