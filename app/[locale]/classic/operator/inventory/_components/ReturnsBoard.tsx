'use client'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import type { OrderReturn } from '@/lib/types'
import { hasPermission, useAbility } from '@/lib/permissions'
import { Dialog } from '@/components/ui/dialog'
import { useGoodsReturnData } from '@/lib/hooks/use-goods-return-data'
import { VerifyReturnDialog, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'
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
import { buildWarehousePendingRows } from './warehouse-pending-rows'

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

  const searchParams = useSearchParams()
  const [dialog, setDialog] = useState<DialogState>(null)
  const highlightHandled = useRef(false)

  // 这里只做 UX 层面的按钮显隐，真正的拦截在后端 withAuth；
  // 按权限点而不是按角色名判断——角色名匹配对管理员新建的自定义角色会误判
  // （即便该角色已被授予对应权限点，字符串匹配仍判它没有，20261027 code-review 改）
  const ability = useAbility()
  const canVerify = hasPermission(ability, 'dispatch.goods_return.warehouse_verify')
  const canReview = hasPermission(ability, 'dispatch.goods_return.review')

  const { trips, orderReturns, loading, reload: load } = useGoodsReturnData(isEn)

  const allTripRows = flattenTripReturns(trips)

  const warehousePending: CardRow[] = buildWarehousePendingRows(trips, orderReturns)

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

  // 退换货补全 M4：消息广场自动发帖的 linkUrl 带 ?highlight=<id>&source=，跳转过来直接
  // 弹出对应记录，不用用户自己在三栏里找。只在第一次成功匹配时打开一次，避免数据刷新
  // （useRefetchOnFocus）时反复弹窗。
  useEffect(() => {
    if (highlightHandled.current || loading) return
    const highlight = searchParams.get('highlight')
    const source = searchParams.get('source')
    if (!highlight || !source) return
    const match = [...warehousePending, ...pendingReview, ...done].find(r => {
      if (source === 'order_return') return r.source === 'order_return' && r.orderReturnRow?.id === highlight
      // tripRow 是 FlatReturn：.id 是 `${tripId}-${ri}-${ei}` 合成行 key，不是真实
      // ReturnItem.id（真实 id 存在 .returnId，跟 bulletin linkUrl 里带的 highlight 同源，
      // 见 TripReturnReviewDialog.tsx 的 FlatReturn 定义）；之前拿 .id 比会恒不匹配，
      // 待审核/已处理状态的退货点广场帖子永远弹不出弹窗（code-review high 发现 #5）
      if (source === 'trip') return r.source === 'trip' && (r.pendingRow?.id === highlight || r.tripRow?.returnId === highlight)
      return false
    })
    if (match) {
      highlightHandled.current = true
      openCard(match)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, warehousePending, pendingReview, done])

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
