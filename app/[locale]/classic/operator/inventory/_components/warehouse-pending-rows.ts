import type { Trip, OrderReturn } from '@/lib/types'
import { flattenPending, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'
import type { ReturnStatus } from './TripReturnReviewDialog'

export interface WarehousePendingRow {
  key: string
  source: 'trip' | 'order_return'
  status: ReturnStatus
  createdAt: string
  restaurantName: string
  productName: string
  quantity: number
  reason?: string
  actionType?: string
  pendingRow?: PendingReturn
  orderReturnRow?: OrderReturn
}

function byDateDesc(a: WarehousePendingRow, b: WarehousePendingRow) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

/**
 * 退换货补全 M1：待核实（WAREHOUSE_PENDING）队列的拼装逻辑，被旧「退换货」tab
 * （ReturnsBoard 第一栏）和新「车辆检查」tab（VehicleInspectionBoard）共用，
 * 避免两处重复同样的 Trip/OrderReturn 映射代码。
 */
export function buildWarehousePendingRows(trips: Trip[], orderReturns: OrderReturn[]): WarehousePendingRow[] {
  const pendingTripRows = flattenPending(trips)
  return [
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
}
