'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { Trip, OrderReturn } from '@/lib/types'
import { hasPermission, useAbility } from '@/lib/permissions'
import { Dialog } from '@/components/ui/dialog'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import { VerifyReturnDialog, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'
import { OrderReturnDialog } from './OrderReturnDialog'
import { buildWarehousePendingRows, type WarehousePendingRow } from './warehouse-pending-rows'

/**
 * 退换货补全 M1：次日仓库验车专用队列，从「退换货」tab 的三栏看板里拆出来单独
 * 占一个 tab——验车是仓库一次性动作，只需要看"待核实"，不需要在这里也看
 * 已经转去销售审核或已处理完的历史（那些留在「退换货」tab 里）。
 *
 * 数据与弹窗都复用 buildWarehousePendingRows + VerifyReturnDialog/OrderReturnDialog，
 * 跟「退换货」tab 第一栏共享同一套逻辑，不重复实现。
 */

type DialogState =
  | { kind: 'trip-verify'; item: PendingReturn }
  | { kind: 'order-return'; item: OrderReturn }
  | null

export default function VehicleInspectionBoard() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [trips, setTrips] = useState<Trip[]>([])
  const [orderReturns, setOrderReturns] = useState<OrderReturn[]>([])
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)

  const ability = useAbility()
  const canVerify = hasPermission(ability, 'dispatch.goods_return.warehouse_verify')

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
  useRefetchOnFocus([load])

  const rows = buildWarehousePendingRows(trips, orderReturns)

  function openCard(row: WarehousePendingRow) {
    if (row.source === 'trip') setDialog({ kind: 'trip-verify', item: row.pendingRow! })
    else setDialog({ kind: 'order-return', item: row.orderReturnRow! })
  }

  function renderCard(row: WarehousePendingRow) {
    return (
      <button
        key={row.key}
        onClick={() => openCard(row)}
        className="w-full text-left rounded-lg border border-gray-200 bg-white hover:border-purple-300 hover:shadow-sm transition-all px-3 py-2.5 space-y-1"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm text-gray-900 truncate">{row.restaurantName}</span>
          <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
            row.source === 'trip' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
          }`}>
            {row.source === 'trip' ? (isEn ? '🚚 Driver' : '🚚 司机上报') : (isEn ? '📝 Manual' : '📝 手动登记')}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-700 truncate mr-2">{row.productName}</span>
          <span className="text-orange-700 font-semibold flex-shrink-0">×{row.quantity}</span>
        </div>
        {row.reason && <div className="text-xs text-gray-400 truncate">{isEn ? 'Reason: ' : '原因：'}{row.reason}</div>}
        <div className="text-[11px] text-gray-400">{new Date(row.createdAt).toLocaleDateString('en-GB')}</div>
      </button>
    )
  }

  return (
    <div>
      {loading && trips.length === 0 && orderReturns.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-600 px-1">
            {isEn ? `Pending Vehicle Check (${rows.length})` : `待核实 (${rows.length})`}
          </h3>
          <div className="rounded-lg bg-gray-50 border border-gray-100 p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 min-h-[120px]">
            {rows.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-6 col-span-full">
                {isEn ? 'Nothing pending check' : '暂无待核实记录'}
              </p>
            ) : (
              rows.map(renderCard)
            )}
          </div>
        </div>
      )}

      {dialog?.kind === 'trip-verify' && (
        <Dialog open onOpenChange={o => { if (!o) setDialog(null) }}>
          <VerifyReturnDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={load} readOnly={!canVerify} />
        </Dialog>
      )}
      {dialog?.kind === 'order-return' && (
        <OrderReturnDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={load} readOnly={!canVerify} />
      )}
    </div>
  )
}
