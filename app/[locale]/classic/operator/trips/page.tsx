'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { openAuthedPdf } from '@/lib/print/open-pdf'
import { Pagination } from '@/components/ui/pagination'
import type { Trip, TripStatus, TripRestaurant, Order } from '@/lib/types'
import { batchPeriod } from '@/lib/delivery-batches'
import { formatDriverSlot, type DriverSlotInfo } from '@/lib/driver-slot'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// ─── Status display ───────────────────────────────────────────────────────────

const STATUS_LABEL_ZH: Record<TripStatus, string> = {
  pending:            '待出发',
  pending_assignment: '待指派司机',
  verifying:          '货物核验',
  in_progress:        '配送中',
  completed:          '已完成',
}
const STATUS_LABEL_EN: Record<TripStatus, string> = {
  pending:            'Pending Departure',
  pending_assignment: 'Pending Driver',
  verifying:          'Verifying',
  in_progress:        'In Delivery',
  completed:          'Completed',
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
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderGroup {
  restaurantId: string
  restaurantName: string
  orders: Order[]
  totalAmount: number
  itemCount: number
  alreadyAssigned: boolean
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function groupOrdersByRestaurant(
  orders: Order[],
  assignedOrderIds: Set<string>,
): OrderGroup[] {
  const map = new Map<string, OrderGroup>()
  for (const o of orders) {
    if (!map.has(o.restaurantId)) {
      map.set(o.restaurantId, {
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        orders: [],
        totalAmount: 0,
        itemCount: 0,
        alreadyAssigned: false,
      })
    }
    const g = map.get(o.restaurantId)!
    g.orders.push(o)
    g.totalAmount += Number(o.totalAmount)
    g.itemCount += (o.items as unknown[]).length
    if (assignedOrderIds.has(o.id)) g.alreadyAssigned = true
  }
  return Array.from(map.values())
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const FACET_DEFS: ClientFacetDef<Trip>[] = [
  { key: 'name',   label: '行程', labelEn: 'Trip',   values: r => [r.name ?? r.id] },
  { key: 'driver', label: '司机', labelEn: 'Driver', values: r => [r.driverName] },
  { key: 'slot',   label: '时段', labelEn: 'Slot',   values: r => [r.timeSlot] },
  { key: 'status', label: '状态', labelEn: 'Status', values: r => [r.status] },
]

export default function ClassicTripsPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // List state
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)

  // Creation modal state
  const [showCreate, setShowCreate] = useState(false)
  const [step, setStep] = useState(1) // 1=batch 2=orders 3=confirm
  const [selectedBatch, setSelectedBatch] = useState('')
  const [batchFilter, setBatchFilter] = useState<'AM' | 'PM' | ''>('')
  const [confirmedOrders, setConfirmedOrders] = useState<Order[]>([])
  const [assignedOrderIds, setAssignedOrderIds] = useState<Set<string>>(new Set())
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  useEffect(() => { apiGet<DriverSlotInfo[]>('/api/driver-slots').then(setDriverSlots).catch(() => {}) }, [])

  // ── List ──────────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<Record<string, unknown>[]>('/api/trips')
      setTrips(data.map(normalizeTrip))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load trips' : '加载行程失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // ── Modal: open ───────────────────────────────────────────────────────────
  async function openCreate() {
    setStep(1)
    setSelectedBatch('')
    setBatchFilter('')
    setSelectedOrderIds(new Set())
    setShowCreate(true)

    // Pre-fetch orders + assigned IDs
    setLoadingOrders(true)
    try {
      const [ordersRaw, tripsRaw] = await Promise.all([
        apiGet<Record<string, unknown>[]>('/api/orders?status=CONFIRMED,WAVE_ASSIGNED&include_lines=false'),
        apiGet<Record<string, unknown>[]>('/api/trips'),
      ])

      // Only CONFIRMED orders
      const confirmed = ordersRaw
        .filter(o => {
          const st = ((o.status as string) ?? '').toLowerCase()
          return st === 'confirmed' || st === 'wave_assigned'
        })
        .map(o => ({ ...(o as unknown as Order), status: ((o.status as string) ?? '').toLowerCase() as Order['status'] }))
      setConfirmedOrders(confirmed)

      // Collect order IDs already in non-completed trips
      const usedIds = new Set<string>()
      for (const t of tripsRaw) {
        const ts = ((t.status as string) ?? '').toLowerCase()
        if (ts === 'completed') continue
        const rests = (t.restaurants as Array<{ orderIds: string[] }>) ?? []
        for (const r of rests) for (const id of r.orderIds) usedIds.add(id)
      }
      setAssignedOrderIds(usedIds)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load data' : '加载数据失败'))
    } finally {
      setLoadingOrders(false)
    }
  }

  function closeCreate() {
    setShowCreate(false)
  }

  // ── Modal: step 2 helpers ─────────────────────────────────────────────────
  const orderGroups = groupOrdersByRestaurant(confirmedOrders, assignedOrderIds)

  function toggleGroup(g: OrderGroup) {
    if (g.alreadyAssigned) return
    const ids = g.orders.map(o => o.id)
    const allSelected = ids.every(id => selectedOrderIds.has(id))
    setSelectedOrderIds(prev => {
      const next = new Set(prev)
      if (allSelected) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }

  function toggleAll() {
    const available = orderGroups.filter(g => !g.alreadyAssigned).flatMap(g => g.orders.map(o => o.id))
    const allSelected = available.every(id => selectedOrderIds.has(id))
    setSelectedOrderIds(allSelected ? new Set() : new Set(available))
  }

  // ── Modal: create ─────────────────────────────────────────────────────────
  async function handleCreate() {
    if (!selectedBatch || selectedOrderIds.size === 0) return
    setCreating(true)
    try {
      const slot = driverSlots.find(s => s.id === selectedBatch)
      const batchStr = slot ? formatDriverSlot(slot) : selectedBatch
      const created = await apiPost<{ id: string }>('/api/trips', {
        timeSlot: slot ? (slot.timeOfDay.toLowerCase().includes('am') ? 'AM' : 'PM') : batchPeriod(selectedBatch),
        deliveryBatch: batchStr,
        driverSlotId: slot?.id || null,
        orderIds: Array.from(selectedOrderIds),
      })
      toast.success(isEn ? 'Trip created successfully' : '行程创建成功')
      setShowCreate(false)
      await load()
      router.push(`${prefix}/classic/operator/trips/${created.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create trip' : '创建行程失败'))
    } finally {
      setCreating(false)
    }
  }

  // ── Derived for preview ───────────────────────────────────────────────────
  const selectedGroups = orderGroups.filter(g => g.orders.some(o => selectedOrderIds.has(o.id)))
  const selectedSlot = driverSlots.find(s => s.id === selectedBatch)
  const selectedBatchLabel = selectedSlot ? formatDriverSlot(selectedSlot) : selectedBatch
  const previewName = selectedBatch
    ? (isEn ? `${selectedBatchLabel} · ${selectedGroups.length} restaurants` : `${selectedBatchLabel} · ${selectedGroups.length}家餐馆`)
    : ''
  const filteredBatches = batchFilter
    ? driverSlots.filter(s => (s.timeOfDay.toLowerCase().includes('am') ? 'AM' : 'PM') === batchFilter)
    : driverSlots

  // ── Filter ────────────────────────────────────────────────────────────────
  const { facets, chips, controlPanelProps } = useFacets(localizeClientFacetDefs(FACET_DEFS, isEn))

  const searched = searchInput
    ? trips.filter(t =>
        t.id.toLowerCase().includes(searchInput.toLowerCase()) ||
        (t.name ?? '').toLowerCase().includes(searchInput.toLowerCase()) ||
        (t.driverName ?? '').toLowerCase().includes(searchInput.toLowerCase())
      )
    : trips
  const filtered = filterByFacets(searched, facets, FACET_DEFS)

  const PAGE_SIZE = 20
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: OdooColumn[] = [
    {
      key: 'timeSlot',
      label: isEn ? 'Slot' : '时段',
      render: (v) => {
        if (!v) return <span className="text-gray-400">—</span>
        return (
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${v === 'AM' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
            {v === 'AM' ? (isEn ? '☀️ AM' : '☀️ 上午') : (isEn ? '🌙 PM' : '🌙 下午')}
          </span>
        )
      },
    },
    {
      key: 'name',
      label: isEn ? 'Trip Name' : '行程名称',
      render: (_, row) => {
        const driverName = row.driverName as string | undefined
        const restaurants = (row.restaurants as TripRestaurant[]) ?? []
        if (driverName) {
          return (
            <span className="font-medium">
              {driverName} · {isEn ? `${restaurants.length} restaurants` : `${restaurants.length}家餐馆`}
            </span>
          )
        }
        if (restaurants.length > 0) {
          const names = restaurants.map(r => r.restaurantName)
          const preview = names.slice(0, 2).join(isEn ? ', ' : '、')
          const extra = names.length > 2 ? ` +${names.length - 2}` : ''
          return <span className="font-medium text-gray-700">{preview}{extra}</span>
        }
        return <span className="text-gray-400">—</span>
      },
    },
    {
      key: 'restaurants',
      label: isEn ? 'Restaurants' : '餐馆数',
      render: (_, row) => (
        <span className="text-sm">{(row.restaurants as unknown[]).length}{isEn ? '' : ' 家'}</span>
      ),
    },
    {
      key: 'status',
      label: isEn ? 'Status' : '状态',
      render: (v) => (
        <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[v as TripStatus] ?? 'bg-gray-100 text-gray-600'}`}>
          {STATUS_LABEL[v as TripStatus] ?? String(v)}
        </span>
      ),
    },
    {
      key: '_print',
      label: isEn ? 'Print' : '打印',
      render: (_, row) => {
        const id = String(row.id)
        const open = (type: 'picking' | 'delivery' | 'summary' | 'receipt') => (e: React.MouseEvent) => {
          e.stopPropagation()
          if (type === 'summary') {
            // 汇总单走真·服务端 PDF（无浏览器打印页眉），不再导航到 /classic/print/trip/[id]/summary
            openAuthedPdf(`/api/trips/${id}/summary-pdf`).catch(err => {
              toast.error(err instanceof Error ? err.message : (isEn ? 'Print failed' : '打印失败'))
            })
            return
          }
          window.open(`${prefix}/classic/print/trip/${id}/${type}`, '_blank')
        }
        const openPicking = (variant: 'storable' | 'consumable') => (e: React.MouseEvent) => {
          e.stopPropagation()
          // 拣货单走真·服务端 PDF（无浏览器打印页眉），不再导航到 /classic/print/trip/[id]/picking
          openAuthedPdf(`/api/trips/${id}/picking-pdf?variant=${variant}`).catch(err => {
            toast.error(err instanceof Error ? err.message : (isEn ? 'Print failed' : '打印失败'))
          })
        }
        return (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              onClick={openPicking('storable')}
              title={isEn ? 'Case/bulk picking list (no price)' : '整箱整袋拣货单（无价）'}
              className="text-xs px-1.5 py-0.5 rounded border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
            >{isEn ? '📦 Case/Bulk' : '📦 整箱整袋'}</button>
            <button
              type="button"
              onClick={openPicking('consumable')}
              title={isEn ? 'Loose goods picking list (no price)' : '零散货拣货单（无价）'}
              className="text-xs px-1.5 py-0.5 rounded border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
            >{isEn ? '🧴 Loose Goods' : '🧴 零散货'}</button>
            <button
              type="button"
              onClick={open('delivery')}
              title={isEn ? 'Driver delivery note (per customer, with price)' : '司机送货单（按客户一家一份，含价）'}
              className="text-xs px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            >{isEn ? '🚚 Delivery' : '🚚 送货'}</button>
            <button
              type="button"
              onClick={open('summary')}
              title={isEn ? 'Delivery summary (per customer card, no price)' : '配送汇总单（按客户卡片，无价）'}
              className="text-xs px-1.5 py-0.5 rounded border border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
            >{isEn ? '📋 Summary' : '📋 汇总'}</button>
            <button
              type="button"
              onClick={open('receipt')}
              title={isEn
                ? 'Proof of delivery (customer signature per stop)'
                : '客户签收单（每站一页，含客户手写签名；未签收的留空白栏供纸质补签）'}
              className="text-xs px-1.5 py-0.5 rounded border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100"
            >{isEn ? '✍️ POD' : '✍️ 签收单'}</button>
          </div>
        )
      },
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      <OdooControlPanel
        {...controlPanelProps}
        activeFilters={chips}
        breadcrumb={isEn ? ['Delivery', 'Trips'] : ['配送', '配送行程']}
        permanentActions={[
          {
            label: isEn ? '+ New Trip' : '+ 新建行程',
            onClick: openCreate,
          },
          { label: isEn ? 'Batch Analysis' : '批次分析', onClick: () => router.push(`${prefix}/classic/operator/batch-analysis`) },
          { label: isEn ? 'Refresh' : '刷新', onClick: load },
        ]}
        searchValue={searchInput}
        onSearch={v => { setSearchInput(v); setPage(1) }}
        onSearchSubmit={() => setPage(1)}
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      <div className="p-4">
        <OdooTable
          columns={columns}
          rows={pageRows as unknown as Record<string, unknown>[]}
          loading={loading}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(pageRows.map(t => t.id)))
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
          onRowClick={row => router.push(`${prefix}/classic/operator/trips/${String(row.id)}`)}
          emptyText={isEn ? 'No delivery trips' : '暂无配送行程'}
        />
        <Pagination page={page} totalPages={Math.ceil(filtered.length / PAGE_SIZE)} onPageChange={setPage} />
      </div>

      {/* ── 新建行程 Modal ─────────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={open => { if (!open) closeCreate() }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle style={{ color: '#875A7B' }}>{isEn ? 'New Delivery Trip' : '新建配送行程'}</DialogTitle>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center gap-2 py-2">
            {[1, 2, 3].map(s => (
              <div key={s} className="flex items-center gap-1">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  step === s ? 'text-white' : step > s ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
                }`} style={step === s ? { background: '#875A7B' } : {}}>
                  {step > s ? '✓' : s}
                </div>
                {s < 3 && <div className={`flex-1 h-0.5 w-8 ${step > s ? 'bg-green-400' : 'bg-gray-200'}`} />}
              </div>
            ))}
            <span className="ml-2 text-xs text-gray-500">
              {step === 1 ? (isEn ? 'Select Batch' : '选择批次') : step === 2 ? (isEn ? 'Select Orders' : '选择订单') : (isEn ? 'Confirm & Generate' : '确认生成')}
            </span>
          </div>

          {/* Step 1: Select batch */}
          {step === 1 && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-gray-600 font-medium">{isEn ? 'Select delivery batch' : '选择配送批次'}</p>
              {/* AM / PM filter */}
              <div className="flex gap-2">
                <button
                  onClick={() => setBatchFilter(batchFilter === 'AM' ? '' : 'AM')}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    batchFilter === 'AM'
                      ? 'border-amber-400 bg-amber-50 text-amber-700'
                      : 'border-gray-200 text-gray-500 hover:border-amber-300'
                  }`}
                >
                  {isEn ? '☀️ AM' : '☀️ 上午 AM'}
                </button>
                <button
                  onClick={() => setBatchFilter(batchFilter === 'PM' ? '' : 'PM')}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    batchFilter === 'PM'
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 text-gray-500 hover:border-indigo-300'
                  }`}
                >
                  {isEn ? '🌙 PM' : '🌙 下午 PM'}
                </button>
                {batchFilter && (
                  <button
                    onClick={() => setBatchFilter('')}
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    {isEn ? 'Show all' : '显示全部'}
                  </button>
                )}
              </div>
              {/* Batch list */}
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {filteredBatches.map(s => {
                  const period = s.timeOfDay.toLowerCase().includes('am') ? 'AM' : 'PM'
                  const label = formatDriverSlot(s)
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSelectedBatch(s.id)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg border-2 transition-all flex items-center gap-3 ${
                        selectedBatch === s.id
                          ? 'border-purple-400 bg-[#875A7B]/20'
                          : 'border-gray-200 hover:border-purple-200'
                      }`}
                    >
                      <span className="text-base">{period === 'AM' ? '☀️' : '🌙'}</span>
                      <span className="font-medium text-sm flex-1">{label}</span>
                      {selectedBatch === s.id && <span className="text-purple-700 text-sm">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Step 2: Select orders */}
          {step === 2 && (
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600 font-medium">{isEn ? 'Select restaurants / orders to deliver' : '选择要配送的餐馆 / 订单'}</p>
                <button
                  onClick={toggleAll}
                  className="text-xs text-purple-700 hover:underline"
                >
                  {isEn ? 'Select All / Clear' : '全选 / 取消'}
                </button>
              </div>

              {loadingOrders && (
                <div className="text-sm text-gray-400 py-4 text-center">{isEn ? 'Loading…' : '加载中…'}</div>
              )}

              {!loadingOrders && orderGroups.length === 0 && (
                <div className="text-sm text-gray-400 py-8 text-center">
                  {isEn ? 'No confirmed orders' : '暂无已确认的订单'}
                </div>
              )}

              {!loadingOrders && orderGroups.map(g => {
                const groupOrderIds = g.orders.map(o => o.id)
                const allChecked = groupOrderIds.every(id => selectedOrderIds.has(id))
                return (
                  <div
                    key={g.restaurantId}
                    onClick={() => toggleGroup(g)}
                    className={`rounded-lg border p-3 cursor-pointer transition-all ${
                      g.alreadyAssigned
                        ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                        : allChecked
                        ? 'border-purple-300 bg-[#875A7B]/20'
                        : 'border-gray-200 hover:border-purple-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          readOnly
                          checked={allChecked}
                          disabled={g.alreadyAssigned}
                          className="w-4 h-4 accent-purple-700"
                        />
                        <span className="font-medium text-sm">{g.restaurantName}</span>
                        {g.alreadyAssigned && (
                          <span className="text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">{isEn ? 'Assigned' : '已指派'}</span>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium">€{g.totalAmount.toFixed(2)}</div>
                        <div className="text-xs text-gray-400">{isEn ? `${g.orders.length} orders · ${g.itemCount} items` : `${g.orders.length} 张订单 · ${g.itemCount} 项`}</div>
                      </div>
                    </div>
                  </div>
                )
              })}

              {selectedOrderIds.size > 0 && (
                <p className="text-xs text-purple-700 font-medium">
                  {isEn ? `Selected ${selectedGroups.length} restaurants, ${selectedOrderIds.size} orders` : `已选 ${selectedGroups.length} 家餐馆，${selectedOrderIds.size} 张订单`}
                </p>
              )}
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && (
            <div className="space-y-4 py-4">
              <p className="text-sm text-gray-600 font-medium">{isEn ? 'Confirm trip details' : '确认行程信息'}</p>

              <div className="rounded-xl border border-purple-200 bg-[#875A7B]/20 p-4 space-y-3">
                <div className="text-center">
                  <div className="text-2xl mb-1">{selectedSlot ? (selectedSlot.timeOfDay.toLowerCase().includes('am') ? '☀️' : '🌙') : ''}</div>
                  <div className="font-bold text-lg" style={{ color: '#875A7B' }}>{previewName}</div>
                </div>
                <div className="border-t border-purple-200 pt-3 space-y-1">
                  {selectedGroups.map(g => (
                    <div key={g.restaurantId} className="flex justify-between text-sm">
                      <span className="text-gray-700">• {g.restaurantName}</span>
                      <span className="text-gray-500">€{g.totalAmount.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-xs text-gray-400 text-center">
                {isEn ? 'Order status will update to "In Delivery" after generation' : '生成后订单状态将更新为「配送中」'}
              </p>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              if (step === 1) closeCreate()
              else setStep(s => s - 1)
            }}>
              {step === 1 ? (isEn ? 'Cancel' : '取消') : (isEn ? 'Previous' : '上一步')}
            </Button>

            {step < 3 ? (
              <Button
                onClick={() => setStep(s => s + 1)}
                disabled={
                  (step === 1 && !selectedBatch) ||
                  (step === 2 && selectedOrderIds.size === 0)
                }
                style={{ background: '#875A7B', borderColor: '#875A7B' }}
                className="text-white hover:opacity-90"
              >
                {isEn ? 'Next' : '下一步'}
              </Button>
            ) : (
              <Button
                onClick={handleCreate}
                disabled={creating}
                style={{ background: '#875A7B', borderColor: '#875A7B' }}
                className="text-white hover:opacity-90"
              >
                {creating ? (isEn ? 'Generating…' : '生成中…') : (isEn ? '✅ Generate Trip' : '✅ 生成行程')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}
