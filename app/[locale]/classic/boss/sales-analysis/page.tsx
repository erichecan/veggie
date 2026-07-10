'use client'
import { useState, useEffect, useRef } from 'react'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

// ─── Measures ────────────────────────────────────────────────────────────────
type MeasureKey =
  | 'count' | 'lines' | 'qtyOrdered' | 'qtyDelivered' | 'qtyInvoiced'
  | 'total' | 'untaxedTotal' | 'unitPrice' | 'margin' | 'discountAmount'
  | 'commissionTotal'

const MEASURES: { key: MeasureKey; label: string }[] = [
  { key: 'count',          label: 'Count' },
  { key: 'lines',          label: '# of Lines' },
  { key: 'qtyOrdered',     label: 'Qty Ordered' },
  { key: 'qtyDelivered',   label: 'Qty Delivered' },
  { key: 'qtyInvoiced',    label: 'Qty Invoiced' },
  { key: 'total',          label: 'Total' },
  { key: 'untaxedTotal',   label: 'Untaxed Total' },
  { key: 'unitPrice',      label: 'Unit Price' },
  { key: 'margin',         label: 'Margin' },
  { key: 'discountAmount', label: 'Discount Amount' },
  { key: 'commissionTotal',label: 'Commission Total' },
]

// ─── Group By ─────────────────────────────────────────────────────────────────
type GroupKey = 'salesperson' | 'product' | 'customer'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'salesperson', label: 'Salesperson' },
  { key: 'product',     label: 'Product' },
  { key: 'customer',    label: 'Customer' },
]

// ─── View types ───────────────────────────────────────────────────────────────
type ViewType = 'pie' | 'bar' | 'list'

// ─── Palette ─────────────────────────────────────────────────────────────────
const PALETTE = [
  '#875A7B', '#E07B54', '#4C9BE8', '#56B87A', '#F5C842',
  '#8E6CC0', '#D64E6A', '#2BBFBF', '#E8843C', '#6494B7',
  '#A0C45A', '#C76BB5', '#5586CA', '#E9A741', '#69C0A0',
]

function colorFor(i: number) { return PALETTE[i % PALETTE.length] }

// ─── Aggregation ─────────────────────────────────────────────────────────────
interface Segment { label: string; value: number }

function aggregate(
  orders: (Order & { salesman?: string })[],
  group: GroupKey,
  measure: MeasureKey,
): Segment[] {
  const map = new Map<string, number>()

  for (const o of orders) {
    const items = o.items ?? []

    if (group === 'salesperson') {
      const key = o.salesman || '(未分配)'
      const val = measureOrder(o, items, measure)
      map.set(key, (map.get(key) ?? 0) + val)
    } else if (group === 'customer') {
      const key = o.restaurantName || '(未知客户)'
      const val = measureOrder(o, items, measure)
      map.set(key, (map.get(key) ?? 0) + val)
    } else {
      // group by product — one segment per product
      if (items.length === 0) continue
      for (const item of items) {
        const key = item.productName || '(未知商品)'
        const val = measureItem(o, item, measure)
        map.set(key, (map.get(key) ?? 0) + val)
      }
    }
  }

  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .filter(s => s.value > 0)
    .sort((a, b) => b.value - a.value)
}

function measureOrder(
  o: Order & { salesman?: string },
  items: Order['items'],
  measure: MeasureKey,
): number {
  switch (measure) {
    case 'count':         return 1
    case 'lines':         return items.length
    case 'qtyOrdered':    return items.reduce((s, i) => s + (i.quantity ?? 0), 0)
    case 'qtyDelivered':  return items.reduce((s, i) => s + (i.deliveredQty ?? 0), 0)
    case 'qtyInvoiced':   return items.reduce((s, i) => s + (i.invoicedQty ?? 0), 0)
    case 'total':         return o.totalAmount ?? 0
    case 'untaxedTotal': {
      const taxSum = items.reduce((s, i) => {
        const rate = (i.taxRate ?? 0) > 1 ? (i.taxRate ?? 0) / 100 : (i.taxRate ?? 0)
        return s + (i.subtotal ?? 0) * rate
      }, 0)
      return (o.totalAmount ?? 0) - taxSum
    }
    case 'unitPrice':     return items.reduce((s, i) => s + (i.price ?? 0), 0) / Math.max(items.length, 1)
    case 'margin':        return 0
    case 'discountAmount':return 0
    // SSOT: 司机提成读送达时冻结的 driverCommissionTotal（件提成+固定费+抽成），不再按下单量实时估算
    case 'commissionTotal': return o.driverCommissionTotal ?? 0
  }
}

function measureItem(
  o: Order,
  item: Order['items'][0],
  measure: MeasureKey,
): number {
  switch (measure) {
    case 'count':         return 1
    case 'lines':         return 1
    case 'qtyOrdered':    return item.quantity ?? 0
    case 'qtyDelivered':  return item.deliveredQty ?? 0
    case 'qtyInvoiced':   return item.invoicedQty ?? 0
    case 'total':         return item.subtotal ?? 0
    case 'untaxedTotal': {
      const rate = (item.taxRate ?? 0) > 1 ? (item.taxRate ?? 0) / 100 : (item.taxRate ?? 0)
      return (item.subtotal ?? 0) * (1 - rate)
    }
    case 'unitPrice':     return item.price ?? 0
    case 'margin':        return 0
    case 'discountAmount':return 0
    // 按商品拆分时只能展示件提成分项(不含客户固定费/抽成，那两项是整单维度、无法按商品分摊)；口径与实送量一致
    case 'commissionTotal': return (item.commissionPrice ?? 0) * (item.deliveredQty ?? 0)
  }
}

// ─── SVG Pie Chart ────────────────────────────────────────────────────────────
function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const start = polarToXY(cx, cy, r, startDeg)
  const end = polarToXY(cx, cy, r, endDeg)
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y} Z`
}

interface PieChartProps {
  segments: Segment[]
  hoveredIndex: number | null
  onHover: (i: number | null) => void
  formatValue: (v: number) => string
}

function PieChart({ segments, hoveredIndex, onHover, formatValue }: PieChartProps) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0 || segments.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        暂无数据
      </div>
    )
  }

  const CX = 160, CY = 160, R = 130
  let cursor = 0
  const slices = segments.map((s, i) => {
    const deg = (s.value / total) * 360
    const start = cursor
    cursor += deg
    return { ...s, start, end: cursor, color: colorFor(i) }
  })

  return (
    <svg viewBox="0 0 320 320" className="w-full max-w-xs mx-auto">
      {slices.map((sl, i) => {
        const isHovered = hoveredIndex === i
        const scale = isHovered ? 1.04 : 1
        const path = describeArc(CX, CY, R, sl.start, sl.end)
        const midDeg = sl.start + (sl.end - sl.start) / 2
        const labelPos = polarToXY(CX, CY, R * 0.65, midDeg)
        const pct = ((sl.value / total) * 100).toFixed(1)
        return (
          <g
            key={i}
            style={{ transform: `scale(${scale})`, transformOrigin: `${CX}px ${CY}px`, transition: 'transform 0.15s ease' }}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            className="cursor-pointer"
          >
            <path d={path} fill={sl.color} stroke="white" strokeWidth={2} />
            {(sl.end - sl.start) > 12 && (
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={10}
                fill="white"
                fontWeight="bold"
              >
                {pct}%
              </text>
            )}
          </g>
        )
      })}
      {/* Center label on hover */}
      {hoveredIndex !== null && slices[hoveredIndex] && (
        <>
          <circle cx={CX} cy={CY} r={48} fill="white" />
          <text x={CX} y={CY - 10} textAnchor="middle" fontSize={9} fill="#6b7280">
            {slices[hoveredIndex].label.length > 14
              ? slices[hoveredIndex].label.slice(0, 13) + '…'
              : slices[hoveredIndex].label}
          </text>
          <text x={CX} y={CY + 8} textAnchor="middle" fontSize={13} fontWeight="bold" fill="#111827">
            {formatValue(slices[hoveredIndex].value)}
          </text>
          <text x={CX} y={CY + 24} textAnchor="middle" fontSize={9} fill="#9ca3af">
            {((slices[hoveredIndex].value / total) * 100).toFixed(1)}%
          </text>
        </>
      )}
    </svg>
  )
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────
function BarChart({ segments, hoveredIndex, onHover, formatValue }: PieChartProps) {
  if (segments.length === 0) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无数据</div>
  }
  const max = Math.max(...segments.map(s => s.value))
  return (
    <div className="space-y-2 px-2 py-4">
      {segments.map((seg, i) => (
        <div
          key={i}
          className="flex items-center gap-3 cursor-pointer group"
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(null)}
        >
          <div
            className="text-xs text-right shrink-0 truncate"
            style={{ width: 120, color: '#374151' }}
            title={seg.label}
          >
            {seg.label}
          </div>
          <div className="flex-1 relative h-6 bg-gray-100 rounded overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded transition-all"
              style={{
                width: `${(seg.value / max) * 100}%`,
                background: hoveredIndex === i ? colorFor(i) + 'cc' : colorFor(i),
              }}
            />
          </div>
          <div className="text-xs font-mono shrink-0 w-20 text-right" style={{ color: colorFor(i) }}>
            {formatValue(seg.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtValue(measure: MeasureKey, v: number): string {
  if (['total', 'untaxedTotal', 'unitPrice', 'margin', 'discountAmount', 'commissionTotal'].includes(measure)) {
    return eur(v)
  }
  if (['qtyOrdered', 'qtyDelivered', 'qtyInvoiced'].includes(measure)) {
    return v.toFixed(1)
  }
  return String(Math.round(v))
}

// ─── Filter ──────────────────────────────────────────────────────────────────
type FilterType = 'all' | 'today' | 'week' | 'month'

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'all',   label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'week',  label: '本周' },
  { key: 'month', label: '本月' },
]

function filterOrders(orders: Order[], filter: FilterType): Order[] {
  if (filter === 'all') return orders
  const now = new Date()
  const start = new Date()
  if (filter === 'today') { start.setHours(0, 0, 0, 0) }
  else if (filter === 'week') { start.setDate(now.getDate() - now.getDay()); start.setHours(0, 0, 0, 0) }
  else if (filter === 'month') { start.setDate(1); start.setHours(0, 0, 0, 0) }
  return orders.filter(o => new Date(o.createdAt) >= start)
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SalesAnalysisPage() {
  const [orders, setOrders] = useState<(Order & { salesman?: string })[] | null>(null)
  const [measure, setMeasure] = useState<MeasureKey>('total')
  const [group, setGroup] = useState<GroupKey>('salesperson')
  const [view, setView] = useState<ViewType>('pie')
  const [filter, setFilter] = useState<FilterType>('all')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [measureOpen, setMeasureOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const measureRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiGet<(Order & { salesman?: string })[]>('/api/orders?include_lines=false').then(setOrders).catch(() => {})
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (measureRef.current && !measureRef.current.contains(e.target as Node)) setMeasureOpen(false)
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) setGroupOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!orders) return <div className="text-gray-400 py-20 text-center">加载中…</div>

  const filtered = filterOrders(orders, filter)
  const segments = aggregate(filtered, group, measure)
  const total = segments.reduce((s, x) => s + x.value, 0)
  const measureLabel = MEASURES.find(m => m.key === measure)?.label ?? measure
  const groupLabel = GROUPS.find(g => g.key === group)?.label ?? group

  function fmt(v: number) { return fmtValue(measure, v) }

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sales Analysis</h1>
          <p className="text-sm text-gray-400 mt-0.5">Odoo 风格销售分析报表</p>
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3 shadow-sm">

        {/* View toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          {([['pie','🥧','饼图'],['bar','📊','柱状'],['list','☰','列表']] as const).map(([v, icon, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              title={label}
              className="px-3 py-1.5 text-sm transition-colors"
              style={view === v
                ? { background: PURPLE, color: 'white' }
                : { background: 'white', color: '#6b7280' }
              }
            >
              {icon}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-gray-200" />

        {/* Measures dropdown */}
        <div className="relative" ref={measureRef}>
          <button
            onClick={() => setMeasureOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white"
          >
            <span>Measures</span>
            <span className="text-gray-400">▾</span>
          </button>
          {measureOpen && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[180px] py-1">
              {MEASURES.map(m => (
                <button
                  key={m.key}
                  onClick={() => { setMeasure(m.key); setMeasureOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                >
                  {measure === m.key && <span style={{ color: PURPLE }}>✓</span>}
                  {measure !== m.key && <span className="w-4" />}
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Group By dropdown */}
        <div className="relative" ref={groupRef}>
          <button
            onClick={() => setGroupOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white"
          >
            <span>Group By</span>
            <span className="text-gray-400">▾</span>
          </button>
          {groupOpen && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[160px] py-1">
              {GROUPS.map(g => (
                <button
                  key={g.key}
                  onClick={() => { setGroup(g.key); setGroupOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                >
                  {group === g.key && <span style={{ color: PURPLE }}>✓</span>}
                  {group !== g.key && <span className="w-4" />}
                  {g.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-gray-200" />

        {/* Filters */}
        <div className="flex items-center gap-1">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="px-3 py-1.5 rounded-lg text-sm transition-colors border"
              style={filter === f.key
                ? { background: PURPLE, color: 'white', borderColor: PURPLE }
                : { background: 'white', color: '#6b7280', borderColor: '#e5e7eb' }
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="ml-auto text-xs text-gray-400">
          {filtered.length} 笔订单 · {groupLabel} by {measureLabel}
        </div>
      </div>

      {/* ── Main Content ───────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">

        {view !== 'list' && (
          <div className="flex flex-col lg:flex-row">
            {/* Chart */}
            <div className="flex-1 flex items-center justify-center py-8 px-4 min-h-[340px]">
              {view === 'pie' ? (
                <PieChart
                  segments={segments}
                  hoveredIndex={hoveredIndex}
                  onHover={setHoveredIndex}
                  formatValue={fmt}
                />
              ) : (
                <div className="w-full max-w-xl">
                  <BarChart
                    segments={segments}
                    hoveredIndex={hoveredIndex}
                    onHover={setHoveredIndex}
                    formatValue={fmt}
                  />
                </div>
              )}
            </div>

            {/* Legend (right panel) */}
            <div className="lg:w-72 border-t lg:border-t-0 lg:border-l border-gray-100 p-4 overflow-y-auto max-h-[500px]">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                {groupLabel}
              </div>
              {segments.length === 0 && (
                <div className="text-sm text-gray-400 text-center py-8">暂无数据</div>
              )}
              {segments.map((seg, i) => {
                const pct = total > 0 ? ((seg.value / total) * 100).toFixed(1) : '0.0'
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 py-2 px-2 rounded-lg cursor-pointer transition-colors"
                    style={hoveredIndex === i ? { background: '#f3eff5' } : {}}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ background: colorFor(i) }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-800 truncate" title={seg.label}>{seg.label}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-semibold text-gray-900">{fmt(seg.value)}</div>
                      <div className="text-[10px] text-gray-400">{pct}%</div>
                    </div>
                  </div>
                )
              })}
              {segments.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between px-2">
                  <span className="text-xs font-bold text-gray-600">Total</span>
                  <span className="text-xs font-bold text-gray-900">{fmt(total)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* List view ─────────────────────────────────────────────────────── */}
        {view === 'list' && (
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-5 py-3 font-semibold text-gray-600">{groupLabel}</th>
                  <th className="text-right px-5 py-3 font-semibold text-gray-600">{measureLabel}</th>
                  <th className="text-right px-5 py-3 font-semibold text-gray-600">%</th>
                </tr>
              </thead>
              <tbody>
                {segments.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center py-16 text-gray-400">暂无数据</td>
                  </tr>
                )}
                {segments.map((seg, i) => {
                  const pct = total > 0 ? ((seg.value / total) * 100).toFixed(1) : '0.0'
                  return (
                    <tr
                      key={i}
                      className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                      onMouseEnter={() => setHoveredIndex(i)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    >
                      <td className="px-5 py-3 flex items-center gap-2.5">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(i) }} />
                        {seg.label}
                      </td>
                      <td className="text-right px-5 py-3 font-mono text-gray-800">{fmt(seg.value)}</td>
                      <td className="text-right px-5 py-3 text-gray-500">{pct}%</td>
                    </tr>
                  )
                })}
              </tbody>
              {segments.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50">
                    <td className="px-5 py-3 font-bold text-gray-700">Total</td>
                    <td className="text-right px-5 py-3 font-bold font-mono text-gray-900">{fmt(total)}</td>
                    <td className="text-right px-5 py-3 font-bold text-gray-600">100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* ── Summary bar ─────────────────────────────────────────────────────── */}
      {segments.length > 0 && (
        <div className="mt-4 bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">占比分布</div>
          <div className="flex h-3 rounded-full overflow-hidden gap-px">
            {segments.map((seg, i) => (
              <div
                key={i}
                title={`${seg.label}: ${fmt(seg.value)} (${((seg.value / total) * 100).toFixed(1)}%)`}
                style={{ flex: seg.value, background: colorFor(i) }}
                className="cursor-pointer transition-opacity hover:opacity-80"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 mt-3">
            {segments.slice(0, 8).map((seg, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorFor(i) }} />
                {seg.label}
              </div>
            ))}
            {segments.length > 8 && (
              <div className="text-xs text-gray-400">+{segments.length - 8} 更多</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
