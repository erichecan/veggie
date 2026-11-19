'use client'
import UnmatchedReturnIntakes from '@/components/warehouse/UnmatchedReturnIntakes'
import ReturnRegistration from '../../daily-sales/_components/ReturnRegistration'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import type { OrderReturn } from '@/lib/types'
import { hasPermission, useAbility } from '@/lib/permissions'
import { Dialog } from '@/components/ui/dialog'
import { useGoodsReturnData } from '@/lib/hooks/use-goods-return-data'
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

  const [vehicleQuery, setVehicleQuery] = useState('')
  const [dialog, setDialog] = useState<DialogState>(null)

  const ability = useAbility()
  const canVerify = hasPermission(ability, 'dispatch.goods_return.warehouse_verify')

  const { trips, orderReturns, loading, reload: load } = useGoodsReturnData(isEn)

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
        {row.orderReturnRow?.sourceTrip && <div className="text-xs text-blue-700">{row.orderReturnRow.sourceTrip.driverName || '—'} · {row.orderReturnRow.sourceTrip.vehiclePlate || (isEn ? 'No plate recorded' : '未记录车牌')} · {new Date(row.orderReturnRow.sourceTrip.createdAt).toLocaleDateString('en-GB')}</div>}
        {row.reason && <div className="text-xs text-gray-400 truncate">{isEn ? 'Reason: ' : '原因：'}{row.reason}</div>}
        <div className="text-[11px] text-gray-400">{new Date(row.createdAt).toLocaleDateString('en-GB')}</div>
      </button>
    )
  }

  return (
    <div>
      <UnmatchedReturnIntakes isEn={isEn} canVerify={canVerify} onSaved={load} />
      {canVerify && <details className="mb-3 rounded border bg-white p-3"><summary className="cursor-pointer font-semibold text-sm">{isEn ? 'Register unreported returned goods' : '仓库发起退货（司机漏报）'}</summary><ReturnRegistration refreshKey={0} /></details>}
      <div className="mb-3 rounded border bg-white p-3"><h3 className="mb-2 text-sm font-semibold">{isEn ? 'Vehicle / driver trip history (including trips without reported returns)' : '车辆 / 司机配送记录（包含未申报退货的行程）'}</h3><input aria-label={isEn ? 'Find vehicle or driver' : '查找车牌或司机'} value={vehicleQuery} onChange={e => setVehicleQuery(e.target.value)} placeholder={isEn ? 'Vehicle plate / driver…' : '输入车牌 / 司机…'} className="mb-2 rounded border p-2 text-sm" /><div className="max-h-48 overflow-y-auto text-xs space-y-1">{[...trips].filter(trip => !vehicleQuery.trim() || `${trip.vehiclePlate ?? ''} ${trip.driverName ?? ''} ${trip.name ?? ''}`.toLowerCase().includes(vehicleQuery.trim().toLowerCase())).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(trip => <div key={trip.id} className="flex flex-wrap gap-3 border-b py-1"><b>{trip.vehiclePlate || '—'}</b><span>{trip.driverName || '—'}</span><span>{trip.name}</span><span>{new Date(trip.createdAt).toLocaleDateString('en-GB')}</span><span>{trip.restaurants.reduce((sum, stop) => sum + (stop.returns?.length ?? 0), 0)} {isEn ? 'legacy reports' : '旧退货记录'} / {orderReturns.filter(row => row.sourceTripId === trip.id).length} {isEn ? 'return reports' : '退货申报'}</span><div className="w-full text-gray-600">{orderReturns.filter(row => row.sourceTripId === trip.id).map(row => `${row.productName} × ${row.quantity} (${row.status})`).join(' · ')}</div></div>)}</div></div>
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
