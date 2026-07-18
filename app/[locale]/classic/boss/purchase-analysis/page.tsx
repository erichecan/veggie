'use client'
import { useState, useEffect, useRef } from 'react'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'

const TEAL = '#0E7490'

// ─── Types ────────────────────────────────────────────────────────────────────
interface POLine {
  id: string
  productName: string
  orderedQty: number
  unitCost: number
  subtotalExTax?: number
}

interface PurchaseOrder {
  id: string
  name: string
  status: string
  supplierId: string
  supplierName?: string
  orderDate: string
  subtotalExTax: number
  totalIncTax: number
  createdAt: string
  lines: POLine[]
}

// ─── Measures ─────────────────────────────────────────────────────────────────
type MeasureKey = 'count' | 'lines' | 'qtyOrdered' | 'subtotalExTax' | 'totalIncTax'

const MEASURES: { key: MeasureKey; label: string }[] = [
  { key: 'count',        label: 'Count' },
  { key: 'lines',        label: '# of Lines' },
  { key: 'qtyOrdered',   label: 'Qty Ordered' },
  { key: 'subtotalExTax',label: 'Untaxed Amount' },
  { key: 'totalIncTax',  label: 'Total (inc. Tax)' },
]

// ─── Group By ─────────────────────────────────────────────────────────────────
type GroupKey = 'supplier' | 'product' | 'status'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'supplier', label: 'Supplier' },
  { key: 'product',  label: 'Product' },
  { key: 'status',   label: 'Status' },
]

// ─── View ─────────────────────────────────────────────────────────────────────
type ViewType = 'pie' | 'bar' | 'list'

// ─── Palette ─────────────────────────────────────────────────────────────────
const PALETTE = [
  '#0E7490', '#0369A1', '#047857', '#B45309', '#7C3AED',
  '#BE185D', '#0F766E', '#C2410C', '#1D4ED8', '#15803D',
  '#A21CAF', '#B91C1C', '#0284C7', '#D97706', '#059669',
]
function colorFor(i: number) { return PALETTE[i % PALETTE.length] }

// ─── Aggregation ─────────────────────────────────────────────────────────────
interface Segment { label: string; value: number }

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '询价单', SENT: '询价单已发送', CONFIRMED: '采购订单',
  RECEIVED: '已收货', INVOICED: '已开票', CANCELLED: '已取消',
}

function aggregate(orders: PurchaseOrder[], group: GroupKey, measure: MeasureKey): Segment[] {
  const map = new Map<string, number>()

  for (const po of orders) {
    if (group === 'supplier') {
      const key = po.supplierName || po.supplierId || '(未知供应商)'
      map.set(key, (map.get(key) ?? 0) + measurePO(po, measure))
    } else if (group === 'status') {
      const key = STATUS_LABEL[po.status] ?? po.status
      map.set(key, (map.get(key) ?? 0) + measurePO(po, measure))
    } else {
      // group by product
      for (const line of po.lines) {
        const key = line.productName || '(未知商品)'
        const val = measureLine(line, measure)
        map.set(key, (map.get(key) ?? 0) + val)
      }
    }
  }

  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .filter(s => s.value > 0)
    .sort((a, b) => b.value - a.value)
}

function measurePO(po: PurchaseOrder, measure: MeasureKey): number {
  switch (measure) {
    case 'count':         return 1
    case 'lines':         return po.lines.length
    case 'qtyOrdered':    return po.lines.reduce((s, l) => s + l.orderedQty, 0)
    case 'subtotalExTax': return po.subtotalExTax ?? 0
    case 'totalIncTax':   return po.totalIncTax ?? 0
  }
}

function measureLine(line: POLine, measure: MeasureKey): number {
  switch (measure) {
    case 'count':         return 1
    case 'lines':         return 1
    case 'qtyOrdered':    return line.orderedQty
    case 'subtotalExTax': return line.subtotalExTax ?? (line.orderedQty * line.unitCost)
    case 'totalIncTax':   return line.subtotalExTax ?? (line.orderedQty * line.unitCost)
  }
}

// ─── SVG Pie ──────────────────────────────────────────────────────────────────
function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function describeArc(cx: number, cy: number, r: number, start: number, end: number) {
  const s = polarToXY(cx, cy, r, start)
  const e = polarToXY(cx, cy, r, end)
  const large = end - start > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y} Z`
}

interface ChartProps {
  segments: Segment[]
  hoveredIndex: number | null
  onHover: (i: number | null) => void
  formatValue: (v: number) => string
}

function PieChart({ segments, hoveredIndex, onHover, formatValue }: ChartProps) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0 || segments.length === 0) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无数据</div>
  }
  const CX = 160, CY = 160, R = 130
  let cursor = 0
  const slices = segments.map((s, i) => {
    const deg = (s.value / total) * 360
    const start = cursor; cursor += deg
    return { ...s, start, end: cursor, color: colorFor(i) }
  })
  return (
    <svg viewBox="0 0 320 320" className="w-full max-w-xs mx-auto">
      {slices.map((sl, i) => {
        const scale = hoveredIndex === i ? 1.04 : 1
        const path = describeArc(CX, CY, R, sl.start, sl.end)
        const mid = sl.start + (sl.end - sl.start) / 2
        const lp = polarToXY(CX, CY, R * 0.65, mid)
        const pct = ((sl.value / total) * 100).toFixed(1)
        return (
          <g key={i}
            style={{ transform: `scale(${scale})`, transformOrigin: `${CX}px ${CY}px`, transition: 'transform 0.15s ease' }}
            onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(null)}
            className="cursor-pointer"
          >
            <path d={path} fill={sl.color} stroke="white" strokeWidth={2} />
            {(sl.end - sl.start) > 12 && (
              <text x={lp.x} y={lp.y} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="white" fontWeight="bold">
                {pct}%
              </text>
            )}
          </g>
        )
      })}
      {hoveredIndex !== null && slices[hoveredIndex] && (
        <>
          <circle cx={CX} cy={CY} r={48} fill="white" />
          <text x={CX} y={CY - 10} textAnchor="middle" fontSize={9} fill="#6b7280">
            {slices[hoveredIndex].label.length > 14 ? slices[hoveredIndex].label.slice(0, 13) + '…' : slices[hoveredIndex].label}
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

function BarChart({ segments, hoveredIndex, onHover, formatValue }: ChartProps) {
  if (segments.length === 0) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无数据</div>
  }
  const max = Math.max(...segments.map(s => s.value))
  return (
    <div className="space-y-2 px-2 py-4">
      {segments.map((seg, i) => (
        <div key={i} className="flex items-center gap-3 cursor-pointer"
          onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(null)}>
          <div className="text-xs text-right shrink-0 truncate" style={{ width: 120, color: '#374151' }} title={seg.label}>
            {seg.label}
          </div>
          <div className="flex-1 relative h-6 bg-gray-100 rounded overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded transition-all"
              style={{ width: `${(seg.value / max) * 100}%`, background: hoveredIndex === i ? colorFor(i) + 'cc' : colorFor(i) }} />
          </div>
          <div className="text-xs font-mono shrink-0 w-20 text-right" style={{ color: colorFor(i) }}>
            {formatValue(seg.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Format ───────────────────────────────────────────────────────────────────
function fmtValue(measure: MeasureKey, v: number): string {
  if (measure === 'subtotalExTax' || measure === 'totalIncTax') return eur(v)
  if (measure === 'qtyOrdered') return v.toFixed(1)
  return String(Math.round(v))
}

// ─── Filter ───────────────────────────────────────────────────────────────────
type FilterType = 'all' | 'today' | 'week' | 'month'

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'all',   label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'week',  label: '本周' },
  { key: 'month', label: '本月' },
]

function filterPOs(orders: PurchaseOrder[], filter: FilterType): PurchaseOrder[] {
  if (filter === 'all') return orders
  const now = new Date()
  const start = new Date()
  if (filter === 'today') { start.setHours(0, 0, 0, 0) }
  else if (filter === 'week') { start.setDate(now.getDate() - now.getDay()); start.setHours(0, 0, 0, 0) }
  else if (filter === 'month') { start.setDate(1); start.setHours(0, 0, 0, 0) }
  return orders.filter(o => new Date(o.createdAt) >= start)
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function PurchaseAnalysisPage() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null)
  const [measure, setMeasure] = useState<MeasureKey>('subtotalExTax')
  const [group, setGroup] = useState<GroupKey>('supplier')
  const [view, setView] = useState<ViewType>('pie')
  const [filter, setFilter] = useState<FilterType>('all')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [measureOpen, setMeasureOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const measureRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)

  const REQUEST_LIMIT = 5000
  useEffect(() => {
    apiGet<PurchaseOrder[]>(`/api/purchase-orders?limit=${REQUEST_LIMIT}`).then(setOrders).catch(() => {})
  }, [])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (measureRef.current && !measureRef.current.contains(e.target as Node)) setMeasureOpen(false)
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) setGroupOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!orders) return <div className="text-gray-400 py-20 text-center">加载中…</div>

  const filtered = filterPOs(orders, filter)
  const segments = aggregate(filtered, group, measure)
  const total = segments.reduce((s, x) => s + x.value, 0)
  const measureLabel = MEASURES.find(m => m.key === measure)?.label ?? measure
  const groupLabel = GROUPS.find(g => g.key === group)?.label ?? group
  function fmt(v: number) { return fmtValue(measure, v) }

  // KPI summary
  const activePOs = filtered.filter(o => !['CANCELLED'].includes(o.status))
  const totalSpend = activePOs.reduce((s, o) => s + o.subtotalExTax, 0)
  const confirmedPOs = filtered.filter(o => ['CONFIRMED', 'RECEIVED', 'INVOICED'].includes(o.status))
  const receivedPOs = filtered.filter(o => o.status === 'RECEIVED' || o.status === 'INVOICED')

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Purchase Analysis</h1>
          <p className="text-sm text-gray-400 mt-0.5">采购订单分析报表</p>
        </div>
      </div>

      {orders.length >= REQUEST_LIMIT && (
        <div className="mb-4 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
          已达到单次拉取上限（{REQUEST_LIMIT} 条），"全部"视图可能不包含更早的历史采购单，统计仅供参考。
        </div>
      )}

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {[
          { label: '采购单数', value: String(filtered.length), sub: `已确认 ${confirmedPOs.length}` },
          { label: '总采购额（税前）', value: eur(totalSpend), sub: `${activePOs.length} 笔有效单` },
          { label: '已收货', value: String(receivedPOs.length), sub: `占比 ${filtered.length > 0 ? ((receivedPOs.length / filtered.length) * 100).toFixed(0) : 0}%` },
          { label: '供应商数', value: String(new Set(filtered.map(o => o.supplierId)).size), sub: '活跃供应商' },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3">
            <p className="text-xs text-gray-400 mb-1">{k.label}</p>
            <p className="text-xl font-bold text-gray-900">{k.value}</p>
            <p className="text-xs text-gray-400 mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Toolbar ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3 shadow-sm">
        {/* View toggle */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          {([['pie','🥧','饼图'],['bar','📊','柱状'],['list','☰','列表']] as const).map(([v, icon, label]) => (
            <button key={v} onClick={() => setView(v)} title={label}
              className="px-3 py-1.5 text-sm transition-colors"
              style={view === v ? { background: TEAL, color: 'white' } : { background: 'white', color: '#6b7280' }}>
              {icon}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-gray-200" />

        {/* Measures */}
        <div className="relative" ref={measureRef}>
          <button onClick={() => setMeasureOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white">
            <span>Measures</span><span className="text-gray-400">▾</span>
          </button>
          {measureOpen && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[200px] py-1">
              {MEASURES.map(m => (
                <button key={m.key} onClick={() => { setMeasure(m.key); setMeasureOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
                  {measure === m.key ? <span style={{ color: TEAL }}>✓</span> : <span className="w-4" />}
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Group By */}
        <div className="relative" ref={groupRef}>
          <button onClick={() => setGroupOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-gray-400 bg-white">
            <span>Group By</span><span className="text-gray-400">▾</span>
          </button>
          {groupOpen && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[160px] py-1">
              {GROUPS.map(g => (
                <button key={g.key} onClick={() => { setGroup(g.key); setGroupOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
                  {group === g.key ? <span style={{ color: TEAL }}>✓</span> : <span className="w-4" />}
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
            <button key={f.key} onClick={() => setFilter(f.key)}
              className="px-3 py-1.5 rounded-lg text-sm transition-colors border"
              style={filter === f.key ? { background: TEAL, color: 'white', borderColor: TEAL } : { background: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="ml-auto text-xs text-gray-400">
          {filtered.length} 笔采购单 · {groupLabel} by {measureLabel}
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        {view !== 'list' && (
          <div className="flex flex-col lg:flex-row">
            <div className="flex-1 flex items-center justify-center py-8 px-4 min-h-[340px]">
              {view === 'pie' ? (
                <PieChart segments={segments} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} formatValue={fmt} />
              ) : (
                <div className="w-full max-w-xl">
                  <BarChart segments={segments} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} formatValue={fmt} />
                </div>
              )}
            </div>
            <div className="lg:w-72 border-t lg:border-t-0 lg:border-l border-gray-100 p-4 overflow-y-auto max-h-[500px]">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{groupLabel}</div>
              {segments.length === 0 ? (
                <p className="text-sm text-gray-400">暂无数据</p>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-gray-400 mb-2">
                    合计：<span className="font-semibold text-gray-700">{fmt(total)}</span>
                  </div>
                  {segments.map((seg, i) => (
                    <div key={i}
                      className="flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors"
                      style={{ background: hoveredIndex === i ? colorFor(i) + '18' : 'transparent' }}
                      onMouseEnter={() => setHoveredIndex(i)} onMouseLeave={() => setHoveredIndex(null)}>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ background: colorFor(i) }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-700 truncate" title={seg.label}>{seg.label}</div>
                        <div className="text-xs text-gray-400">{((seg.value / total) * 100).toFixed(1)}%</div>
                      </div>
                      <div className="text-xs font-mono text-gray-600 shrink-0">{fmt(seg.value)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {view === 'list' && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600">{groupLabel}</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">{measureLabel}</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">占比</th>
              </tr>
            </thead>
            <tbody>
              {segments.length === 0 ? (
                <tr><td colSpan={3} className="text-center py-12 text-gray-400">暂无数据</td></tr>
              ) : segments.map((seg, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2.5 flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(i) }} />
                    {seg.label}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmt(seg.value)}</td>
                  <td className="px-4 py-2.5 text-right text-gray-400">
                    {((seg.value / total) * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                <td className="px-4 py-2.5">合计</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(total)}</td>
                <td className="px-4 py-2.5 text-right">100%</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
