'use client'
import ReturnRegistration from './ReturnRegistration'
import WarehouseUnreportedReturnForm from './WarehouseUnreportedReturnForm'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import type { OrderReturn } from '@/lib/types'
import { hasPermission, useAbility } from '@/lib/permissions'
import { Dialog } from '@/components/ui/dialog'
import { useGoodsReturnData } from '@/lib/hooks/use-goods-return-data'
import { VerifyReturnDialog, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'
import { OrderReturnDialog } from './OrderReturnDialog'
import { buildWarehousePendingRows, type WarehousePendingRow } from './warehouse-pending-rows'
import { apiGet } from '@/lib/api'
import { toast } from 'sonner'

interface ChecklistProduct {
  orderLineId: string
  productId: string
  productName: string
  orderedQuantity: number
  deliveredQuantity: number
  unitName?: string | null
}
interface ChecklistStop {
  customerId: string
  customerName: string
  orders: Array<{ orderId: string; orderCode: string; products: ChecklistProduct[] }>
}
interface ChecklistTrip {
  tripId: string
  tripName: string
  deliveredAt: string
  driverName: string
  vehiclePlate?: string | null
  stops: ChecklistStop[]
}
interface ChecklistResponse { date: string; trips: ChecklistTrip[] }

function yesterdayDateString() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  const date = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')) - 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

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
  const [manifestDate, setManifestDate] = useState(yesterdayDateString)
  const [manifest, setManifest] = useState<ChecklistResponse | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [fleetPlates, setFleetPlates] = useState<string[]>([])
  const [returnRegistration, setReturnRegistration] = useState<{ orderCode: string; orderLineId: string; sourceTripId: string } | null>(null)

  const ability = useAbility()
  const canVerify = hasPermission(ability, 'dispatch.goods_return.warehouse_verify')
  const canReadFleet = hasPermission(ability, 'dispatch.driver_slot.read')

  const { trips, orderReturns, loading, reload: load } = useGoodsReturnData(isEn)

  useEffect(() => {
    if (!canReadFleet) { setFleetPlates([]); return }
    let active = true
    apiGet<Array<{ plate: string }>>('/api/fleet-vehicles')
      .then(rows => { if (active) setFleetPlates(Array.isArray(rows) ? rows.map(row => row.plate) : []) })
      .catch(() => { if (active) setFleetPlates([]) })
    return () => { active = false }
  }, [canReadFleet])

  const vehiclePlates = Array.from(new Set([
    ...fleetPlates,
    ...trips.map(trip => trip.vehiclePlate ?? ''),
    ...(manifest?.trips ?? []).map(trip => trip.vehiclePlate ?? ''),
  ].map(plate => plate.trim()).filter(Boolean)))

  useEffect(() => {
    if (!canVerify) return
    let active = true
    setManifestLoading(true)
    apiGet<ChecklistResponse>(`/api/order-returns/delivery-checklist?date=${encodeURIComponent(manifestDate)}`)
      .then(data => { if (active) setManifest(data) })
      .catch(error => { if (active) toast.error(error instanceof Error ? error.message : (isEn ? 'Could not load delivery manifest' : '加载配送清单失败')) })
      .finally(() => { if (active) setManifestLoading(false) })
    return () => { active = false }
  }, [manifestDate, canVerify, isEn])

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
        {row.orderReturnRow?.sourceTrip && <div className="text-xs text-blue-700">{row.orderReturnRow.sourceTrip.driverName || '—'} · {row.orderReturnRow.sourceTrip.vehiclePlate || (isEn ? 'No plate recorded' : '未记录车牌')} · {new Date(row.orderReturnRow.sourceTrip.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}</div>}
        {row.reason && <div className="text-xs text-gray-400 truncate">{isEn ? 'Reason: ' : '原因：'}{row.reason}</div>}
        <div className="text-[11px] text-gray-400">{isEn ? 'Registered' : '登记时间'}: {new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}</div>
      </button>
    )
  }

  return (
    <div>
      <WarehouseUnreportedReturnForm isEn={isEn} onSaved={load} vehiclePlates={vehiclePlates} />
      {canVerify && <section className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 px-3 py-3">
          <div><h3 className="text-sm font-semibold text-gray-800">{isEn ? 'Delivery reconciliation manifest' : '昨日配送核对清单'}</h3><p className="text-xs text-gray-500">{isEn ? 'Review each driver, vehicle, customer, order and delivered item.' : '按司机和车牌逐项核对配送客户、订单、商品和实送数量。'}</p></div>
          <label className="flex items-center gap-2 text-xs text-gray-600">{isEn ? 'Delivery date' : '配送日期'}<input type="date" value={manifestDate} onChange={event => setManifestDate(event.target.value)} className="rounded border px-2 py-1.5 text-sm" /></label>
        </div>
        <div className="max-h-[55vh] space-y-3 overflow-auto p-3">
          {manifestLoading ? <p className="py-8 text-center text-sm text-gray-400">{isEn ? 'Loading manifest…' : '正在加载配送清单…'}</p>
            : !manifest?.trips.length ? <p className="py-8 text-center text-sm text-gray-400">{isEn ? 'No deliveries for this date' : '该日期没有配送记录'}</p>
            : manifest.trips.map(trip => (
              <article key={trip.tripId} className="overflow-hidden rounded-lg border border-gray-200">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-purple-50 px-3 py-2 text-sm">
                  <div className="font-medium text-gray-800">{trip.driverName}<span className="font-normal text-gray-500"> · {trip.vehiclePlate || (isEn ? 'Plate missing' : '未登记车牌')} · {trip.tripName}</span></div>
                  <time className="text-xs text-gray-500">{new Date(trip.deliveredAt).toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}</time>
                </div>
                <div className="divide-y divide-gray-100">
                  {trip.stops.map(stop => (
                    <div key={`${trip.tripId}-${stop.customerId}`} className="px-3 py-2">
                      <div className="mb-1 text-sm font-medium text-gray-800">🏪 {stop.customerName}</div>
                      {stop.orders.map(order => (
                        <div key={order.orderId} className="mb-2 last:mb-0">
                          <div className="mb-1 text-xs font-medium text-[#714B67]">{isEn ? 'Order' : '订单'} {order.orderCode}</div>
                          {order.products.map(product => (
                            <div key={product.orderLineId} className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-gray-100 py-1.5 text-xs">
                              <span className="min-w-[180px] flex-1 text-gray-700">{product.productName}</span>
                              <span className="whitespace-nowrap text-gray-500">{isEn ? 'Delivered' : '实送'} {product.deliveredQuantity}{product.unitName ? ` ${product.unitName}` : ''}</span>
                              {product.deliveredQuantity > 0 && <button onClick={() => setReturnRegistration({ orderCode: order.orderCode, orderLineId: product.orderLineId, sourceTripId: trip.tripId })} className="rounded border border-purple-200 px-2 py-1 font-medium text-[#714B67] hover:bg-purple-50">{isEn ? 'Register return' : '登记退货'}</button>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </article>
            ))}
        </div>
      </section>}
      {canVerify && <details open={!!returnRegistration} onToggle={event => { if (!event.currentTarget.open && returnRegistration) setReturnRegistration(null) }} className="mb-3 rounded border bg-white p-3"><summary className="cursor-pointer font-semibold text-sm">{isEn ? 'Register unreported returned goods' : '仓库登记退回商品（司机漏报）'}</summary>{returnRegistration && <div className="mb-2 flex items-center justify-between rounded bg-blue-50 px-3 py-2 text-xs text-blue-800"><span>{isEn ? 'From delivery manifest' : '关联配送清单'}: {returnRegistration.orderCode}</span><button onClick={() => setReturnRegistration(null)} className="underline">{isEn ? 'Clear selection' : '清除关联'}</button></div>}<ReturnRegistration key={`${returnRegistration?.orderCode ?? 'manual'}-${returnRegistration?.orderLineId ?? ''}`} refreshKey={0} initialOrderCode={returnRegistration?.orderCode} initialOrderLineId={returnRegistration?.orderLineId} sourceTripId={returnRegistration?.sourceTripId} /></details>}
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
