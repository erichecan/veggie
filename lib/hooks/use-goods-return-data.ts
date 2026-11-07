'use client'
/**
 * useGoodsReturnData - 「退换货」tab 和「车辆检查」tab 共用的数据加载
 * -----------------------------------------------------------------------
 * 两个组件都要同时拉 /api/trips（司机上报）+ /api/order-returns（手动登记）
 * 拼出同一份 trips/orderReturns 状态，原来各自写了一份一字不差的 load()
 * （code-review high 发现 #8：ReturnsBoard.tsx 与 VehicleInspectionBoard.tsx
 * 近乎逐行重复），收成共享 hook，行为不变。
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { Trip, OrderReturn } from '@/lib/types'
import { useRefetchOnFocus } from './use-refetch-on-focus'

export function useGoodsReturnData(isEn: boolean) {
  const [trips, setTrips] = useState<Trip[]>([])
  const [orderReturns, setOrderReturns] = useState<OrderReturn[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [tripsData, returnsData] = await Promise.all([
        apiGet<Record<string, unknown>[]>('/api/trips'),
        apiGet<{ returns: OrderReturn[] }>('/api/order-returns'),
      ])
      const tripRows = tripsData as unknown as Trip[]
      const allReturns = returnsData.returns ?? []
      // Keep driver-originated canonical rows on the trip review UI for the existing
      // refund flow, while the database itself stores them only once in OrderReturn.
      for (const ret of allReturns) {
        if (!ret.sourceTripId) continue
        const trip = tripRows.find(row => row.id === ret.sourceTripId)
        const restaurant = trip?.restaurants.find(row => row.restaurantId === ret.order?.restaurantId)
        if (!restaurant) continue
        if ((restaurant.returns ?? []).some(existing => existing.id === ret.id)) continue
        restaurant.returns = [...(restaurant.returns ?? []), {
          id: ret.id,
          orderId: ret.orderId,
          orderLineId: ret.orderLineId ?? undefined,
          sourceTripId: ret.sourceTripId,
          productId: ret.productId,
          productName: ret.productName,
          quantity: Number(ret.quantity),
          photo: ret.photo ?? undefined,
          unitPrice: ret.unitPrice == null ? undefined : Number(ret.unitPrice),
          refundMode: ret.refundMode ?? undefined,
          refundPct: ret.refundPct == null ? undefined : Number(ret.refundPct),
          refundAmount: ret.refundAmount == null ? undefined : Number(ret.refundAmount),
          refundNote: ret.refundNote ?? undefined,
          lateReportNote: ret.lateReportNote ?? undefined,
          reason: ret.reason,
          actionType: ret.actionType,
          status: ret.status,
          disposition: ret.disposition,
          exchangeOrderId: ret.exchangeOrderId,
          createdAt: ret.createdAt,
        }]
      }
      setTrips(tripRows)
      setOrderReturns(allReturns.filter(ret => !ret.sourceTripId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load data' : '加载数据失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  // 波次/订单在别的 tab 改了之后，切回来希望看到最新结果
  useRefetchOnFocus([load])

  return { trips, orderReturns, loading, reload: load }
}
