'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { Trip, OrderReturn } from '@/lib/types'
import { getSession } from '@/lib/session'
import { Dialog } from '@/components/ui/dialog'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import { flattenPending, VerifyReturnDialog, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'
import {
  flattenTripReturns,
  TripReturnReviewDialog,
  TRIP_STATUS_COLORS,
  TRIP_STATUS_LABELS_ZH,
  TRIP_STATUS_LABELS_EN,
  type FlatReturn,
  type ReturnStatus,
} from './TripReturnReviewDialog'
import { OrderReturnDialog } from './OrderReturnDialog'

/**
 * 退货/报废整合 M1：`warehouse/returns`（仓库核实）+ `operator/returns`（销售审核+disposition）
 * 两个独立孤儿页面合并成这一个三栏看板，数据源同时查 Trip.restaurants[].returns（司机上报）
 * 和 OrderReturn（日销售中心手动登记，M3），标明来源但共用同一套核实/审核/disposition 规则。
 *
 * 三栏固定对应状态机阶段：待核实(WAREHOUSE_PENDING) / 待审核(PENDING_REVIEW) /
 * 已处理(APPROVED+REJECTED+SETTLED 合并展示，这三种都已走完流程，不需要再分栏)。
 */

type DialogState =
  | { kind: 'trip-verify'; item: PendingReturn }
  | { kind: 'trip-review'; item: FlatReturn }
  | { kind: 'order-return'; item: OrderReturn }
  | null

interface CardRow {
  key: string
  source: 'trip' | 'order_return'
  status: ReturnStatus
  createdAt: string
  restaurantName: string
  productName: string
  quantity: number
  reason?: string
  actionType?: string
  disposition?: string
  pendingRow?: PendingReturn
  tripRow?: FlatReturn
  orderReturnRow?: OrderReturn
}

function byDateDesc(a: CardRow, b: CardRow) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

export default function ReturnsBoard() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABELS = isEn ? TRIP_STATUS_LABELS_EN : TRIP_STATUS_LABELS_ZH

  const [trips, setTrips] = useState<Trip[]>([])
  const [orderReturns, setOrderReturns] = useState<OrderReturn[]>([])
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)

  // dispatch.goods_return.warehouse_verify 只发给 WAREHOUSE，review 只发给 OPERATOR/SALES
  // （RBAC 单元既定），这里只做 UX 层面的按钮显隐，真正的拦截在后端 withAuth
  const session = getSession()
  const effectiveRoles = session ? (session.roles && session.roles.length > 0 ? session.roles : [session.role]) : []
  const rolesUpper = effectiveRoles.map(r => r.toUpperCase())
  const canVerify = rolesUpper.includes('WAREHOUSE')
  const canReview = rolesUpper.includes('OPERATOR') || rolesUpper.includes('SALES')

  async function load() {
    setLoading(true)
    try {
      const [tripsData, returnsData] = await Promise.all([
        apiGet<Record<string, unknown>[]>('/api/trips'),
        apiGet<{ returns: OrderReturn[] }>('/api/order-returns'),
      ])
      setTrips(tripsData as unknown as Trip[])
      setOrderReturns(returnsData.returns ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load data' : '加载数据失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  // 波次/订单在别的 tab 改了之后，切回来希望看到最新结果
  useRefetchOnFocus([load])

  const pendingTripRows = flattenPending(trips)
  const allTripRows = flattenTripReturns(trips)

  const warehousePending: CardRow[] = [
    ...pendingTripRows.map(r => ({
      key: `trip-${r.tripId}-${r.id ?? r.productId}`,
      source: 'trip' as const,
      status: 'WAREHOUSE_PENDING' as ReturnStatus,
      createdAt: r.createdAt ?? r.tripCreatedAt,
      restaurantName: r.restaurantName,
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      pendingRow: r,
    })),
    ...orderReturns.filter(r => r.status === 'WAREHOUSE_PENDING').map(r => ({
      key: `or-${r.id}`,
      source: 'order_return' as const,
      status: 'WAREHOUSE_PENDING' as ReturnStatus,
      createdAt: r.createdAt,
      restaurantName: r.order?.restaurantName ?? '—',
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      orderReturnRow: r,
    })),
  ].sort(byDateDesc)

  const pendingReview: CardRow[] = [
    ...allTripRows.filter(r => r.status === 'PENDING_REVIEW').map(r => ({
      key: r.id,
      source: 'trip' as const,
      status: 'PENDING_REVIEW' as ReturnStatus,
      createdAt: r.tripCreatedAt,
      restaurantName: r.restaurantName,
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      tripRow: r,
    })),
    ...orderReturns.filter(r => r.status === 'PENDING_REVIEW').map(r => ({
      key: `or-${r.id}`,
      source: 'order_return' as const,
      status: 'PENDING_REVIEW' as ReturnStatus,
      createdAt: r.createdAt,
      restaurantName: r.order?.restaurantName ?? '—',
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      orderReturnRow: r,
    })),
  ].sort(byDateDesc)

  const DONE_STATUSES: ReturnStatus[] = ['APPROVED', 'REJECTED', 'SETTLED']
  const done: CardRow[] = [
    ...allTripRows.filter(r => DONE_STATUSES.includes(r.status)).map(r => ({
      key: r.id,
      source: 'trip' as const,
      status: r.status,
      createdAt: r.tripCreatedAt,
      restaurantName: r.restaurantName,
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      disposition: r.disposition,
      tripRow: r,
    })),
    ...orderReturns.filter(r => DONE_STATUSES.includes(r.status)).map(r => ({
      key: `or-${r.id}`,
      source: 'order_return' as const,
      status: r.status,
      createdAt: r.createdAt,
      restaurantName: r.order?.restaurantName ?? '—',
      productName: r.productName,
      quantity: r.quantity,
      reason: r.reason,
      actionType: r.actionType,
      disposition: r.disposition,
      orderReturnRow: r,
    })),
  ].sort(byDateDesc)

  function openCard(card: CardRow) {
    if (card.source === 'trip') {
      if (card.status === 'WAREHOUSE_PENDING') setDialog({ kind: 'trip-verify', item: card.pendingRow! })
      else setDialog({ kind: 'trip-review', item: card.tripRow! })
    } else {
      setDialog({ kind: 'order-return', item: card.orderReturnRow! })
    }
  }

  function renderCard(card: CardRow) {
    return (
      <button
        key={card.key}
        onClick={() => openCard(card)}
        className="w-full text-left rounded-lg border border-gray-200 bg-white hover:border-purple-300 hover:shadow-sm transition-all px-3 py-2.5 space-y-1"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm text-gray-900 truncate">{card.restaurantName}</span>
          <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
            card.source === 'trip' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
          }`}>
            {card.source === 'trip' ? (isEn ? '🚚 Driver' : '🚚 司机上报') : (isEn ? '📝 Manual' : '📝 手动登记')}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-700 truncate mr-2">{card.productName}</span>
          <span className="text-orange-700 font-semibold flex-shrink-0">×{card.quantity}</span>
        </div>
        {card.reason && <div className="text-xs text-gray-400 truncate">{isEn ? 'Reason: ' : '原因：'}{card.reason}</div>}
        <div className="flex items-center justify-between text-[11px] text-gray-400">
          <span>{new Date(card.createdAt).toLocaleDateString('en-GB')}</span>
          {card.disposition && (
            <span className={card.disposition === 'SCRAP' ? 'text-orange-500' : 'text-green-600'}>
              {card.disposition === 'SCRAP' ? (isEn ? 'Scrap' : '报废') : (isEn ? 'Sellable' : '可再售')}
            </span>
          )}
          {!card.disposition && card.status !== 'PENDING_REVIEW' && (
            <span className={card.status === 'REJECTED' ? 'text-red-500' : ''}>{STATUS_LABELS[card.status]}</span>
          )}
        </div>
      </button>
    )
  }

  const columns: { key: string; title: string; rows: CardRow[]; emptyText: string }[] = [
    {
      key: 'warehouse_pending',
      title: isEn ? `Pending Warehouse Check (${warehousePending.length})` : `待核实 (${warehousePending.length})`,
      rows: warehousePending,
      emptyText: isEn ? 'Nothing pending check' : '暂无待核实记录',
    },
    {
      key: 'pending_review',
      title: isEn ? `Pending Review (${pendingReview.length})` : `待审核 (${pendingReview.length})`,
      rows: pendingReview,
      emptyText: isEn ? 'Nothing pending review' : '暂无待审核记录',
    },
    {
      key: 'done',
      title: isEn ? `Processed (${done.length})` : `已处理 (${done.length})`,
      rows: done,
      emptyText: isEn ? 'No processed records yet' : '暂无已处理记录',
    },
  ]

  return (
    <div>
      {loading && trips.length === 0 && orderReturns.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {columns.map(col => (
            <div key={col.key} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold text-gray-600">{col.title}</h3>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-100 p-2 space-y-2 min-h-[120px] max-h-[70vh] overflow-y-auto">
                {col.rows.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-6">{col.emptyText}</p>
                ) : (
                  col.rows.map(renderCard)
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {dialog?.kind === 'trip-verify' && (
        <Dialog open onOpenChange={o => { if (!o) setDialog(null) }}>
          <VerifyReturnDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={load} readOnly={!canVerify} />
        </Dialog>
      )}
      {dialog?.kind === 'trip-review' && (
        <Dialog open onOpenChange={o => { if (!o) setDialog(null) }}>
          <TripReturnReviewDialog item={dialog.item} allTrips={trips} onClose={() => setDialog(null)} onSaved={load} readOnly={!canReview} />
        </Dialog>
      )}
      {dialog?.kind === 'order-return' && (
        <OrderReturnDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={load}
          readOnly={dialog.item.status === 'WAREHOUSE_PENDING' ? !canVerify : !canReview}
        />
      )}
    </div>
  )
}
