'use client'
import { useState, useEffect, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { apiGet } from '@/lib/api'
import type { Order, OrderLine } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { ChipMultiSelect, today, fmtMoney, lineUntax } from './shared'

type BatchLine = OrderLine & { product?: { template?: { weight?: number | null } | null } | null }

function lineWeight(l: BatchLine): number {
  const w = Number(l.product?.template?.weight ?? 0)
  return w * Number(l.orderedQty)
}

interface BatchGroup {
  batchKey: string
  orders: Order[]
  totalAmount: number
  untaxTotal: number
  totalWeight: number
}

function buildPrintUrl(
  prefix: string,
  type: 'picking' | 'delivery' | 'summary',
  date: string,
  slotId?: string,
  batchKey?: string,
): string {
  const params = new URLSearchParams({ date, fromDate: date })
  if (slotId) params.set('driverSlotId', slotId)
  else if (batchKey) params.set('batchLabel', batchKey)
  return `${prefix}/classic/print/dispatch/${type}?${params.toString()}`
}

// ─── BatchCard ────────────────────────────────────────────────────────────────

function BatchCard({
  group,
  slotKeyToId,
  prefix,
  date,
}: {
  group: BatchGroup
  slotKeyToId: Map<string, string>
  prefix: string
  date: string
}) {
  const [expanded, setExpanded] = useState(false)
  const { batchKey, orders, totalAmount, untaxTotal } = group
  const slotId = slotKeyToId.get(batchKey)
  const parsed = parseDriverSlotKey(batchKey)
  const uniqueCustomers = new Set(orders.map(o => o.restaurantId)).size

  function print(type: 'picking' | 'delivery' | 'summary') {
    window.open(buildPrintUrl(prefix, type, date, slotId, batchKey), '_blank')
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span className="text-gray-400 text-sm">{expanded ? '▾' : '▸'}</span>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {parsed.num > 0 && (
              <span className="bg-[#875A7B] text-white text-xs font-bold rounded px-2 py-0.5">
                批次 {parsed.num}
              </span>
            )}
            {parsed.time && (
              <span className="bg-blue-100 text-blue-700 text-xs font-medium rounded px-2 py-0.5 uppercase">
                {parsed.time}
              </span>
            )}
            {parsed.driver && (
              <span className="font-medium text-gray-900 text-sm">{parsed.driver}</span>
            )}
            {!batchKey && (
              <span className="text-gray-400 text-sm italic">未分配</span>
            )}
            <span className="text-xs text-gray-400">
              {orders.length} 单 · {uniqueCustomers} 客户
            </span>
          </div>
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-900 mr-2">${fmtMoney(totalAmount)}</span>
          <span className="text-xs text-gray-400 mr-3">未税 ${fmtMoney(untaxTotal)}</span>
          <button
            onClick={() => print('picking')}
            className="px-2.5 py-1 text-xs rounded border border-orange-400 text-orange-600 hover:bg-orange-50 transition-colors"
          >
            拣货单
          </button>
          <button
            onClick={() => print('delivery')}
            className="px-2.5 py-1 text-xs rounded border border-blue-400 text-blue-600 hover:bg-blue-50 transition-colors"
          >
            订单
          </button>
          <button
            onClick={() => print('summary')}
            className="px-2.5 py-1 text-xs rounded border border-green-500 text-green-700 hover:bg-green-50 transition-colors"
          >
            汇总单
          </button>
        </div>
      </div>

      {/* Order list */}
      {expanded && (
        <div className="border-t border-gray-100">
          {orders.map(o => (
            <div key={o.id} className="flex items-center gap-3 px-5 py-2 hover:bg-gray-50 border-b border-gray-50">
              <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
              <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
              <span className="text-xs text-gray-500 uppercase">{o.status}</span>
              <span className="text-sm font-medium text-gray-900 w-24 text-right">
                ${fmtMoney(Number(o.totalAmount))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── UnassignedPanel ──────────────────────────────────────────────────────────

function UnassignedPanel({ orders }: { orders: Order[] }) {
  const [expanded, setExpanded] = useState(false)
  if (orders.length === 0) return null
  return (
    <div className="bg-yellow-50 rounded-lg border border-yellow-200 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-4 py-3 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-yellow-500">{expanded ? '▾' : '▸'}</span>
        <span className="text-sm font-medium text-yellow-800">未分配批次</span>
        <span className="text-xs text-yellow-600 ml-1">({orders.length} 单)</span>
      </button>
      {expanded && (
        <div className="border-t border-yellow-200">
          {orders.map(o => (
            <div key={o.id} className="flex items-center gap-3 px-5 py-2 border-b border-yellow-100">
              <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
              <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
              <span className="text-sm font-medium text-gray-900">${fmtMoney(Number(o.totalAmount))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── PrintCenter ──────────────────────────────────────────────────────────────

export default function PrintCenter() {
  const pathname = usePathname()
  const prefix = pathname.match(/^(\/[a-z]{2}(-[A-Z]{2})?)/)?.[1] ?? ''

  const [date, setDate] = useState(today)
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [sortMode, setSortMode] = useState<'batch' | 'driver' | 'time'>('batch')
  const [driverFilter, setDriverFilter] = useState<string[]>([])
  const [timeFilter, setTimeFilter] = useState<string[]>([])
  const [batchFilter, setBatchFilter] = useState<string[]>([])

  useEffect(() => {
    setLoading(true)
    apiGet<Order[]>(
      `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
    )
      .then(data => setOrders(Array.isArray(data) ? data : []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [date])

  const slotKeyToId = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of orders) {
      if (o.driverSlot?.id) {
        m.set(formatDriverSlotFromOrder(o), o.driverSlot.id)
      }
    }
    return m
  }, [orders])

  const filterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const batches = new Set<string>()
    for (const o of orders) {
      const p = parseDriverSlotKey(formatDriverSlotFromOrder(o))
      if (p.driver) drivers.add(p.driver)
      if (p.time) times.add(p.time)
      if (p.num > 0) batches.add(String(p.num))
    }
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      batches: [...batches].sort((a, b) => Number(a) - Number(b)),
    }
  }, [orders])

  const assignedOrders = useMemo(
    () => orders.filter(o => !!formatDriverSlotFromOrder(o)),
    [orders]
  )
  const unassignedOrders = useMemo(
    () => orders.filter(o => !formatDriverSlotFromOrder(o)),
    [orders]
  )

  const filteredOrders = useMemo(() => {
    return assignedOrders.filter(o => {
      const key = formatDriverSlotFromOrder(o)
      const p = parseDriverSlotKey(key)
      if (driverFilter.length > 0 && !driverFilter.includes(p.driver)) return false
      if (timeFilter.length > 0 && !timeFilter.includes(p.time)) return false
      if (batchFilter.length > 0 && !batchFilter.includes(String(p.num))) return false
      return true
    })
  }, [assignedOrders, driverFilter, timeFilter, batchFilter])

  const batchGroups: BatchGroup[] = useMemo(() => {
    const grouped = new Map<string, Order[]>()
    for (const o of filteredOrders) {
      const key = formatDriverSlotFromOrder(o)
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(o)
    }
    const groups = Array.from(grouped.entries()).map(([batchKey, ords]) => ({
      batchKey,
      orders: ords,
      totalAmount: ords.reduce((s, o) => s + Number(o.totalAmount), 0),
      untaxTotal: ords.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineUntax(l), 0), 0),
      totalWeight: ords.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineWeight(l as BatchLine), 0), 0),
    }))

    return groups.sort((a, b) => {
      const pa = parseDriverSlotKey(a.batchKey)
      const pb = parseDriverSlotKey(b.batchKey)
      if (sortMode === 'batch') return pa.num - pb.num || pa.time.localeCompare(pb.time) || pa.driver.localeCompare(pb.driver)
      if (sortMode === 'time') return pa.time.localeCompare(pb.time) || pa.num - pb.num || pa.driver.localeCompare(pb.driver)
      return pa.driver.localeCompare(pb.driver) || pa.num - pb.num
    })
  }, [filteredOrders, sortMode])

  function bulkPrint(type: 'picking' | 'delivery') {
    window.open(buildPrintUrl(prefix, type, date), '_blank')
  }

  const grandTotal = batchGroups.reduce((s, g) => s + g.totalAmount, 0)

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">配送日期</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 ml-2">
            {loading ? (
              <span>加载中...</span>
            ) : (
              <span>共 {orders.length} 单 · {batchGroups.length} 批次 · ${fmtMoney(grandTotal)}</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => bulkPrint('picking')}
              className="px-3 py-1.5 text-xs rounded bg-orange-500 text-white hover:bg-orange-600 transition-colors"
            >
              全部打印拣货单
            </button>
            <button
              onClick={() => bulkPrint('delivery')}
              className="px-3 py-1.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              全部打印送货单
            </button>
          </div>
        </div>

        {/* Sort + Filters */}
        <div className="flex items-center gap-4 flex-wrap border-t border-gray-100 pt-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">排序:</span>
            {(['batch', 'driver', 'time'] as const).map(m => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  sortMode === m ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-500 hover:border-[#875A7B]'
                }`}
              >
                {m === 'batch' ? '批次' : m === 'driver' ? '司机' : '时段'}
              </button>
            ))}
          </div>
          <ChipMultiSelect
            label="司机"
            options={filterOptions.drivers}
            selected={driverFilter}
            onChange={setDriverFilter}
          />
          <ChipMultiSelect
            label="时段"
            options={filterOptions.times}
            selected={timeFilter}
            onChange={setTimeFilter}
          />
          <ChipMultiSelect
            label="批次"
            options={filterOptions.batches}
            selected={batchFilter}
            onChange={setBatchFilter}
          />
        </div>
      </div>

      {/* Batch cards */}
      {loading ? (
        <div className="text-center text-gray-400 py-16 text-sm">加载中...</div>
      ) : batchGroups.length === 0 && unassignedOrders.length === 0 ? (
        <div className="text-center text-gray-400 py-16 text-sm">
          {date} 没有待配送订单
        </div>
      ) : (
        <div className="space-y-3">
          {batchGroups.map(g => (
            <BatchCard
              key={g.batchKey}
              group={g}
              slotKeyToId={slotKeyToId}
              prefix={prefix}
              date={date}
            />
          ))}
          <UnassignedPanel orders={unassignedOrders} />
        </div>
      )}
    </div>
  )
}
