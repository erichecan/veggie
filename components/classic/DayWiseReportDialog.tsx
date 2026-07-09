'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import { formatDriverSlot, formatDriverSlotFromOrder, parseDriverSlotKey, type DriverSlotInfo } from '@/lib/driver-slot'
import type { Order, OrderItem, OrderLine } from '@/lib/types'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string
  name: string
  street?: string
  city?: string
  zip?: string
  notes?: string
  pricelist?: string
  isVendor?: boolean
  address?: string
}

interface ProductRow {
  id: string
  name: string
  salePrice?: number
  category?: string
}

interface CategoryRow { id: string; name: string }
interface UserRow { id: string; name: string }

// Batch analysis types
type BatchLine = OrderLine & { product?: { template?: { weight?: number | null } | null } | null }
type BatchSortMode = 'batch' | 'driver' | 'time'

interface BatchGroup {
  batchKey: string
  orders: Order[]
  totalAmount: number
  untaxTotal: number
  totalWeight: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10) }
function firstOfMonth() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function getDateDOW(d: string) { return new Date(d + 'T00:00:00').getDay() }
function fmtMoney(n: number) { return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function fmtWeight(n: number) { return n.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }

// 行税前(未税)金额。OrderLine.subtotal 恒 = unitPrice×orderedQty,本身已经是税前快照
// (SSOT,见 docs/20260701 审计 + lib/order-items.ts orderIncTaxTotal)，直接返回即可——
// 不能再除以 (1+taxRate)，那样会把已经是税前的金额按税率二次打折，导致界面"未税"数字系统性偏小。
function lineUntax(l: { subtotal: number; taxRate?: number | null }): number {
  return Number(l.subtotal)
}

function lineWeight(l: BatchLine): number {
  const w = Number(l.product?.template?.weight ?? 0)
  return w * Number(l.orderedQty)
}

function toggleValue<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]
}

// ─── Chip multi-select (留空 = 全部) ─────────────────────────────────────────

function ChipMultiSelect<T extends string | number>({
  options,
  selected,
  onToggle,
  onClear,
  renderLabel,
  allLabel,
}: {
  options: T[]
  selected: T[]
  onToggle: (v: T) => void
  onClear: () => void
  renderLabel?: (v: T) => string
  allLabel: string
}) {
  const allActive = selected.length === 0
  return (
    <div className="flex gap-1.5 flex-wrap items-center">
      <button
        type="button"
        onClick={onClear}
        className="px-2.5 py-1 text-xs rounded-full border transition-colors"
        style={allActive
          ? { background: '#875A7B', color: '#fff', borderColor: '#875A7B' }
          : { background: '#fff', color: '#9ca3af', borderColor: '#e5e7eb' }}
        title="清除选择 = 全部"
      >
        {allLabel}
      </button>
      {options.map(opt => {
        const active = selected.includes(opt)
        return (
          <button
            key={String(opt)}
            type="button"
            onClick={() => onToggle(opt)}
            className="px-2.5 py-1 text-xs rounded-full border transition-colors"
            style={active
              ? { background: '#875A7B', color: '#fff', borderColor: '#875A7B' }
              : { background: '#fff', color: '#875A7B', borderColor: '#d4b8d0' }}
          >
            {renderLabel ? renderLabel(opt) : String(opt)}
          </button>
        )
      })}
      {options.length === 0 && <span className="text-xs text-gray-300">无可选项</span>}
    </div>
  )
}

// ─── Inline search row (Odoo-style "+ Add a line") ───────────────────────────

function InlineSearch<T extends { id: string; name: string }>({
  allItems,
  selectedIds,
  onAdd,
  label = '+ Add a line',
  placeholder = '搜索…',
  colSpan = 5,
}: {
  allItems: T[]
  selectedIds: string[]
  onAdd: (item: T) => void
  label?: string
  placeholder?: string
  colSpan?: number
}) {
  const [active, setActive] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = allItems
    .filter(i => !selectedIds.includes(i.id))
    .filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 25)

  useEffect(() => { setHighlight(0) }, [query])

  useEffect(() => {
    if (!active) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setActive(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [active])

  useEffect(() => {
    if (active) setTimeout(() => inputRef.current?.focus(), 20)
  }, [active])

  function select(item: T) {
    onAdd(item)
    setQuery('')
    setActive(false)
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlight]) select(filtered[highlight]) }
    else if (e.key === 'Escape') { setActive(false); setQuery('') }
  }

  return (
    <tr>
      <td className="px-4 py-2" />
      <td className="px-4 py-2" colSpan={colSpan}>
        {active ? (
          <div ref={ref} className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKey}
              placeholder={placeholder}
              className="w-full border border-[#875A7B] rounded px-3 py-1.5 text-sm focus:outline-none"
            />
            {filtered.length > 0 && (
              <div className="absolute z-[100] left-0 right-0 bg-white border border-gray-200 rounded shadow-xl max-h-52 overflow-y-auto mt-0.5">
                {filtered.map((item, idx) => (
                  <div
                    key={item.id}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={e => { e.preventDefault(); select(item) }}
                    className={`px-3 py-2 text-sm cursor-pointer text-gray-700 ${
                      idx === highlight ? 'bg-[#875A7B]/10 text-[#875A7B]' : 'hover:bg-[#875A7B]/10'
                    }`}
                  >
                    {item.name}
                  </div>
                ))}
              </div>
            )}
            {query.length > 0 && filtered.length === 0 && (
              <div className="absolute z-[100] left-0 right-0 bg-white border border-gray-200 rounded shadow-xl mt-0.5 px-3 py-2 text-sm text-gray-400">
                没有匹配结果
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setActive(true)}
            className="text-sm text-[#875A7B] hover:underline font-medium"
          >
            {label}
          </button>
        )}
      </td>
    </tr>
  )
}

// ─── Batch Sub-Components ────────────────────────────────────────────────────

function BatchOrderDetailRow({
  order,
  isLast,
  driverSlots,
  currentSlotId,
  onTransfer,
  onRemove,
  onLinesUpdated,
}: {
  order: Order
  isLast: boolean
  driverSlots: DriverSlotInfo[]
  currentSlotId?: string
  onTransfer: (orderId: string, newSlotId: string) => void
  onRemove: (orderId: string) => void
  onLinesUpdated: (orderId: string) => void
}) {
  const [showItems, setShowItems] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [editingLineId, setEditingLineId] = useState<string | null>(null)
  const [editQty, setEditQty] = useState('')
  const [saving, setSaving] = useState(false)
  const transferRef = useRef<HTMLDivElement>(null)

  const lines = Array.isArray(order.lines) && order.lines.length > 0 ? order.lines as BatchLine[] : null
  const itemCount = lines ? lines.length : (Array.isArray(order.items) ? order.items.length : 0)
  const orderUntax = lines ? lines.reduce((s, l) => s + lineUntax(l), 0) : 0
  const orderWeight = lines ? lines.reduce((s, l) => s + lineWeight(l), 0) : 0

  // Close transfer dropdown on outside click
  useEffect(() => {
    if (!showTransfer) return
    function handler(e: MouseEvent) {
      if (transferRef.current && !transferRef.current.contains(e.target as Node)) setShowTransfer(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showTransfer])

  async function saveLineQty(line: BatchLine) {
    const newQty = parseFloat(editQty)
    if (isNaN(newQty) || newQty < 0) { setEditingLineId(null); return }
    if (newQty === Number(line.orderedQty)) { setEditingLineId(null); return }
    setSaving(true)
    try {
      const updatedLines = (order.lines as BatchLine[]).map(l =>
        l.id === line.id
          ? { ...l, orderedQty: newQty, subtotal: newQty * Number(l.unitPrice) }
          : l
      )
      await apiPut(`/api/orders/${order.id}`, { lines: updatedLines.map(l => ({
        id: l.id, productId: l.productId, productName: l.productName, spec: l.spec,
        uomId: l.uomId, uomName: l.uomName, unitPrice: Number(l.unitPrice),
        taxRate: l.taxRate != null ? Number(l.taxRate) : null,
        orderedQty: Number(l.orderedQty), deliveredQty: Number(l.deliveredQty),
        invoicedQty: Number(l.invoicedQty), subtotal: Number(l.subtotal), sequence: l.sequence,
      }))})
      onLinesUpdated(order.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
      setEditingLineId(null)
    }
  }

  async function deleteLine(lineId: string) {
    if (!lines || lines.length <= 1) { alert('订单至少保留一个商品'); return }
    if (!confirm('确认删除该商品行？')) return
    setSaving(true)
    try {
      const updatedLines = (order.lines as BatchLine[]).filter(l => l.id !== lineId)
      await apiPut(`/api/orders/${order.id}`, { lines: updatedLines.map(l => ({
        id: l.id, productId: l.productId, productName: l.productName, spec: l.spec,
        uomId: l.uomId, uomName: l.uomName, unitPrice: Number(l.unitPrice),
        taxRate: l.taxRate != null ? Number(l.taxRate) : null,
        orderedQty: Number(l.orderedQty), deliveredQty: Number(l.deliveredQty),
        invoicedQty: Number(l.invoicedQty), subtotal: Number(l.subtotal), sequence: l.sequence,
      }))})
      onLinesUpdated(order.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败')
    } finally {
      setSaving(false)
    }
  }

  const otherSlots = driverSlots.filter(s => s.id !== currentSlotId)

  return (
    <div className={isLast ? '' : 'border-b'} style={{ borderColor: '#f0e4ee' }}>
      <div className="w-full flex items-center gap-2 px-5 py-2 text-left hover:bg-[#875A7B]/20 transition-colors text-xs group">
        <button className="text-gray-400 shrink-0" onClick={() => setShowItems(v => !v)}>
          {showItems ? '▼' : '▶'}
        </button>
        <button className="flex-1 flex items-center gap-3 text-left" onClick={() => setShowItems(v => !v)}>
          <span className="font-mono text-gray-500 w-28 shrink-0">{order.code ?? order.id.slice(0, 8)}</span>
          <span className="flex-1 font-medium" style={{ color: '#4a2545' }}>{order.restaurantName}</span>
          <span className="text-gray-400 w-20 shrink-0">{itemCount} 项商品</span>
          {orderWeight > 0 && <span className="text-gray-400 w-20 shrink-0 text-right">{fmtWeight(orderWeight)} kg</span>}
          {orderUntax > 0 && <span className="text-gray-400 w-24 shrink-0 text-right">未税 €{fmtMoney(orderUntax)}</span>}
          <span className="font-semibold w-24 text-right shrink-0" style={{ color: '#875A7B' }}>
            €{fmtMoney(Number(order.totalAmount ?? 0))}
          </span>
        </button>

        {/* Action buttons — visible on hover; stay visible when dropdown is open */}
        <div className={`shrink-0 flex items-center gap-1 transition-opacity ${showTransfer ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <div className="relative" ref={transferRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setShowTransfer(v => !v) }}
              className="px-2 py-1 rounded text-[10px] border transition-colors"
              style={{ color: '#875A7B', borderColor: '#d4b8d0' }}
              title="转移到其他批次/司机"
            >
              ↔ 转移
            </button>
            {showTransfer && (
              <div
                className="fixed z-[9999] bg-white border border-gray-200 rounded shadow-xl w-56 max-h-48 overflow-y-auto"
                style={{ top: transferRef.current ? transferRef.current.getBoundingClientRect().bottom + 4 : 0, left: transferRef.current ? Math.min(transferRef.current.getBoundingClientRect().left, window.innerWidth - 230) : 0 }}
              >
                <div className="px-3 py-2 text-[10px] text-gray-400 border-b">转移到：</div>
                <button
                  className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 text-red-500"
                  onClick={() => { onRemove(order.id); setShowTransfer(false) }}
                >
                  ✕ 取消批次分配
                </button>
                {otherSlots.map(s => (
                  <button
                    key={s.id}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-[#875A7B]/10"
                    style={{ color: '#4a2545' }}
                    onClick={() => { onTransfer(order.id, s.id); setShowTransfer(false) }}
                  >
                    {s.timeOfDay.toUpperCase()} #{s.batchNum} — {s.driverName}
                  </button>
                ))}
                {otherSlots.length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-400">没有其他批次可选</div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => onRemove(order.id)}
            className="px-2 py-1 rounded text-[10px] border border-red-200 text-red-400 hover:bg-red-50 transition-colors"
            title="从批次中移除"
          >
            ✕ 移除
          </button>
        </div>
      </div>

      {showItems && itemCount > 0 && (
        <div className="mx-5 mb-2 border rounded text-xs overflow-hidden" style={{ borderColor: '#e8d8e8' }}>
          <table className="w-full">
            <thead>
              <tr style={{ background: '#f5f0f8' }}>
                <th className="px-3 py-1.5 text-left font-medium" style={{ color: '#875A7B' }}>商品</th>
                <th className="px-3 py-1.5 text-right font-medium" style={{ color: '#875A7B' }}>数量</th>
                <th className="px-3 py-1.5 text-right font-medium" style={{ color: '#875A7B' }}>重量(kg)</th>
                <th className="px-3 py-1.5 text-right font-medium" style={{ color: '#875A7B' }}>单价</th>
                <th className="px-3 py-1.5 text-right font-medium" style={{ color: '#875A7B' }}>小计</th>
                <th className="px-3 py-1.5 w-8" />
              </tr>
            </thead>
            <tbody>
              {lines ? lines.map((l, i) => {
                const wt = lineWeight(l)
                const isEditing = editingLineId === l.id
                return (
                  <tr key={i} className="border-t group/line" style={{ borderColor: '#f0e4ee' }}>
                    <td className="px-3 py-1">{l.productName}{l.spec ? <span className="text-gray-400 ml-1">({l.spec})</span> : null}</td>
                    <td className="px-3 py-1 text-right">
                      {isEditing ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="number"
                            step="any"
                            value={editQty}
                            onChange={e => setEditQty(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveLineQty(l); if (e.key === 'Escape') setEditingLineId(null) }}
                            className="w-16 border rounded px-1 py-0.5 text-right text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                            autoFocus
                            disabled={saving}
                          />
                          <button onClick={() => saveLineQty(l)} className="text-green-500 hover:text-green-700" disabled={saving}>✓</button>
                          <button onClick={() => setEditingLineId(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                        </span>
                      ) : (
                        <span
                          className="cursor-pointer hover:bg-[#875A7B]/10 px-1 rounded"
                          onClick={() => { setEditingLineId(l.id); setEditQty(String(l.orderedQty)) }}
                          title="点击修改数量"
                        >
                          {l.orderedQty} {l.uomName ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right">{wt > 0 ? fmtWeight(wt) : '—'}</td>
                    <td className="px-3 py-1 text-right">€{fmtMoney(Number(l.unitPrice ?? 0))}</td>
                    <td className="px-3 py-1 text-right">€{fmtMoney(Number(l.subtotal ?? 0))}</td>
                    <td className="px-1 py-1 text-center">
                      <button
                        onClick={() => deleteLine(l.id)}
                        className="text-gray-300 hover:text-red-400 opacity-0 group-hover/line:opacity-100 transition-opacity"
                        title="删除商品行"
                        disabled={saving}
                      >×</button>
                    </td>
                  </tr>
                )
              }) : (order.items as OrderItem[]).map((it, i) => (
                <tr key={i} className="border-t" style={{ borderColor: '#f0e4ee' }}>
                  <td className="px-3 py-1">{it.productName}{it.spec ? <span className="text-gray-400 ml-1">({it.spec})</span> : null}</td>
                  <td className="px-3 py-1 text-right">{it.quantity} {it.uomName ?? ''}</td>
                  <td className="px-3 py-1 text-right">—</td>
                  <td className="px-3 py-1 text-right">€{fmtMoney(Number(it.price ?? 0))}</td>
                  <td className="px-3 py-1 text-right">€{fmtMoney(Number(it.subtotal ?? 0))}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RoutePreview({ orders, customerMap }: { orders: Order[]; customerMap: Map<string, CustomerRow> }) {
  const stops = Array.from(new Map(orders.map(o => [o.restaurantId, o.restaurantName])).entries())
  return (
    <div className="px-4 py-3 border-t text-xs space-y-1" style={{ borderColor: '#e8d8e8', background: '#fdfaff' }}>
      <div className="font-medium mb-2" style={{ color: '#875A7B' }}>行程路线（{stops.length} 站）</div>
      {stops.map(([id, name], i) => {
        const c = customerMap.get(id)
        const addr = c ? [c.street, c.city, c.zip].filter(Boolean).join(', ') || c.address || '' : ''
        return (
          <div key={id} className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] shrink-0 mt-0.5"
              style={{ background: '#875A7B' }}>{i + 1}</span>
            <div>
              <span className="font-medium" style={{ color: '#4a2545' }}>{name}</span>
              {addr && <span className="text-gray-400 ml-2">{addr}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BatchCard({
  group,
  customerMap,
  driverSlots,
  currentSlotId,
  onTransfer,
  onRemove,
  onLinesUpdated,
  onPrint,
}: {
  group: BatchGroup
  customerMap: Map<string, CustomerRow>
  driverSlots: DriverSlotInfo[]
  currentSlotId?: string
  onTransfer: (orderId: string, newSlotId: string) => void
  onRemove: (orderId: string) => void
  onLinesUpdated: (orderId: string) => void
  onPrint: (batchKey: string, type: 'picking' | 'delivery' | 'summary') => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showRoute, setShowRoute] = useState(false)
  const { batchKey, orders: bOrders, totalAmount, untaxTotal, totalWeight } = group
  const customerCount = new Set(bOrders.map(o => o.restaurantId)).size
  const canPrint = !!batchKey
  return (
    <div className="border rounded-lg overflow-hidden" style={{ borderColor: '#d4b8d0' }}>
      <div
        className="w-full flex items-center justify-between px-4 py-3"
        style={{ background: expanded ? '#f5f0f8' : '#faf5fc' }}
      >
        <button
          className="flex items-center gap-3 text-left flex-1 min-w-0"
          onClick={() => setExpanded(v => !v)}
        >
          <span className="text-sm font-semibold truncate" style={{ color: '#4a2545' }}>{batchKey || '（未分配批次）'}</span>
          <span className="text-xs px-2 py-0.5 rounded-full text-white shrink-0" style={{ background: '#875A7B' }}>{bOrders.length} 单</span>
          <span className="text-xs text-gray-400 shrink-0">{customerCount} 家客户</span>
          {totalWeight > 0 && (
            <span className="text-xs px-2 py-0.5 rounded border shrink-0" style={{ color: '#875A7B', borderColor: '#d4b8d0' }}>
              {fmtWeight(totalWeight)} kg
            </span>
          )}
        </button>
        <div className="flex items-center gap-3 shrink-0 pl-3">
          {/* Per-batch print buttons — each picking/delivery/summary sheet is for this exact batch */}
          {canPrint && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onPrint(batchKey, 'picking')}
                className="px-2.5 py-1 rounded text-[11px] font-semibold text-white transition-colors"
                style={{ background: '#ea580c' }}
                title="打印该批次拣货单"
              >拣货单</button>
              <button
                onClick={() => onPrint(batchKey, 'delivery')}
                className="px-2.5 py-1 rounded text-[11px] font-semibold text-white transition-colors"
                style={{ background: '#1e40af' }}
                title="打印该批次订单"
              >订单</button>
              <button
                onClick={() => onPrint(batchKey, 'summary')}
                className="px-2.5 py-1 rounded text-[11px] font-semibold text-white transition-colors"
                style={{ background: '#16a34a' }}
                title="打印该批次送货汇总单"
              >汇总单</button>
            </div>
          )}
          {untaxTotal > 0 && (
            <span className="text-xs text-gray-400">未税 €{fmtMoney(untaxTotal)}</span>
          )}
          <span className="text-sm font-bold" style={{ color: '#875A7B' }}>€{fmtMoney(totalAmount)}</span>
          <button onClick={() => setExpanded(v => !v)} className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</button>
        </div>
      </div>
      {expanded && (
        <div className="border-t" style={{ borderColor: '#e8d8e8' }}>
          {bOrders.map((o, idx) => (
            <BatchOrderDetailRow
              key={o.id}
              order={o}
              isLast={idx === bOrders.length - 1}
              driverSlots={driverSlots}
              currentSlotId={currentSlotId}
              onTransfer={onTransfer}
              onRemove={onRemove}
              onLinesUpdated={onLinesUpdated}
            />
          ))}
          <div className="px-4 py-2 flex items-center justify-between border-t text-xs" style={{ borderColor: '#e8d8e8', background: '#f5f0f8' }}>
            <button
              className="px-3 py-1 rounded border text-xs transition-colors"
              style={showRoute ? { background: '#875A7B', color: '#fff', borderColor: '#875A7B' } : { color: '#875A7B', borderColor: '#d4b8d0' }}
              onClick={() => setShowRoute(v => !v)}
            >
              {showRoute ? '▲ 隐藏路线' : '▼ 查看路线'}
            </button>
            <div className="flex gap-4 font-semibold" style={{ color: '#4a2545' }}>
              {totalWeight > 0 && <span>总重量：{fmtWeight(totalWeight)} kg</span>}
              {untaxTotal > 0 && <span>未税合计：€{fmtMoney(untaxTotal)}</span>}
              <span>批次合计：€{fmtMoney(totalAmount)}</span>
            </div>
          </div>
          {showRoute && <RoutePreview orders={bOrders} customerMap={customerMap} />}
        </div>
      )}
    </div>
  )
}

// ─── Unassigned Orders Panel ────────────────────────────────────────────────

function UnassignedOrdersPanel({
  orders,
  driverSlots,
  onAssign,
}: {
  orders: Order[]
  driverSlots: DriverSlotInfo[]
  onAssign: (orderId: string, slotId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = orders.filter(o =>
    !search || o.restaurantName.toLowerCase().includes(search.toLowerCase())
    || (o.code ?? '').toLowerCase().includes(search.toLowerCase())
  )

  if (orders.length === 0) return null

  return (
    <div className="border rounded-lg overflow-hidden" style={{ borderColor: '#f59e0b', background: '#fffbeb' }}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-100 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-amber-700">未分配批次的订单</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500 text-white">{orders.length} 单</span>
        </div>
        <span className="text-amber-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-amber-200">
          <div className="px-4 py-2 border-b border-amber-200">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索客户名或订单号…"
              className="w-full border border-amber-300 rounded px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </div>
          <div className="max-h-60 overflow-y-auto">
            {filtered.map(o => (
              <UnassignedOrderRow key={o.id} order={o} driverSlots={driverSlots} onAssign={onAssign} />
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-3 text-xs text-gray-400 text-center">没有匹配的订单</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function UnassignedOrderRow({
  order,
  driverSlots,
  onAssign,
}: {
  order: Order
  driverSlots: DriverSlotInfo[]
  onAssign: (orderId: string, slotId: string) => void
}) {
  const [showSlots, setShowSlots] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showSlots) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowSlots(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSlots])

  return (
    <div className="flex items-center gap-3 px-5 py-2 border-b border-amber-100 text-xs hover:bg-amber-50">
      <span className="font-mono text-gray-500 w-28 shrink-0">{order.code ?? order.id.slice(0, 8)}</span>
      <span className="flex-1 font-medium text-amber-800">{order.restaurantName}</span>
      <span className="text-gray-400 w-24 text-right">€{fmtMoney(Number(order.totalAmount ?? 0))}</span>
      <div className="relative" ref={ref}>
        <button
          onClick={() => setShowSlots(v => !v)}
          className="px-2 py-1 rounded text-[10px] border bg-white transition-colors"
          style={{ color: '#875A7B', borderColor: '#d4b8d0' }}
        >
          + 分配批次
        </button>
        {showSlots && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded shadow-xl w-56 max-h-48 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] text-gray-400 border-b">分配到：</div>
            {driverSlots.map(s => (
              <button
                key={s.id}
                className="w-full px-3 py-2 text-left text-xs hover:bg-[#875A7B]/10"
                style={{ color: '#4a2545' }}
                onClick={() => { onAssign(order.id, s.id); setShowSlots(false) }}
              >
                {s.timeOfDay.toUpperCase()} #{s.batchNum} — {s.driverName}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

type DialogTab = 'report' | 'batch'

export default function DayWiseReportDialog({ onClose }: { onClose: () => void }) {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [fromDate, setFromDate] = useState(today())
  const [toDate, setToDate] = useState(today())
  const [tab, setTab] = useState<DialogTab>('batch')

  // filter data
  const [allCustomers, setAllCustomers] = useState<CustomerRow[]>([])
  const [allProducts, setAllProducts] = useState<ProductRow[]>([])
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  const [allCategories, setAllCategories] = useState<CategoryRow[]>([])
  const [allSalesmen, setAllSalesmen] = useState<UserRow[]>([])

  // selected filters (shared)
  const [selectedCustomers, setSelectedCustomers] = useState<CustomerRow[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([])
  // Driver / AM-PM / Batch are now three independent multi-select filters (留空 = 全部)
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [selectedTimes, setSelectedTimes] = useState<string[]>([])
  const [selectedBatchNums, setSelectedBatchNums] = useState<number[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedSalesman, setSelectedSalesman] = useState('')

  // batch analysis state
  const [selectedDOW, setSelectedDOW] = useState<number[]>([])
  const [sortMode, setSortMode] = useState<BatchSortMode>('batch')
  const [batchOrders, setBatchOrders] = useState<Order[]>([])
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchFetched, setBatchFetched] = useState(false)

  // customer map for batch route preview
  const customerMap = useMemo(() => {
    const map = new Map<string, CustomerRow>()
    allCustomers.forEach(c => map.set(c.id, c))
    return map
  }, [allCustomers])

  // Load all reference data in parallel
  useEffect(() => {
    Promise.all([
      apiGet<CustomerRow[]>('/api/customers?limit=500').catch(() => []),
      apiGet<ProductRow[]>('/api/products?limit=500').catch(() => []),
      apiGet<DriverSlotInfo[]>('/api/driver-slots').catch(() => []),
      apiGet<CategoryRow[]>('/api/product-categories').catch(() => []),
      apiGet<UserRow[]>('/api/users').catch(() => []),
    ]).then(([custs, prods, slots, cats, users]) => {
      const custArr = (Array.isArray(custs) ? custs : []) as CustomerRow[]
      const prodArr = (Array.isArray(prods) ? prods : []) as ProductRow[]
      setAllCustomers(custArr.filter(c => !c.isVendor))
      setAllProducts(prodArr)
      setDriverSlots(Array.isArray(slots) ? slots : [])
      setAllCategories(Array.isArray(cats) ? cats : [])
      setAllSalesmen(Array.isArray(users) ? users : [])
    })
  }, [])

  // Load batch orders when dates change
  useEffect(() => {
    setBatchLoading(true)
    const params = new URLSearchParams({
      include_lines: 'true',
      status: 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED',
      dateField: 'deliveryDate',
      fromDate: fromDate,
      toDate: toDate,
    })
    apiGet<Order[]>(`/api/orders?${params}`)
      .then(data => { setBatchOrders(Array.isArray(data) ? data : []); setBatchFetched(true) })
      .catch(() => setBatchOrders([]))
      .finally(() => setBatchLoading(false))
  }, [fromDate, toDate])

  // Derive available 司机 / AM-PM / 批次 options from the actual orders' batches
  // (driverSlots config records may be incomplete — orders are the source of truth)
  const batchFilterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const nums = new Set<number>()
    batchOrders.forEach(o => {
      const key = formatDriverSlotFromOrder(o)
      if (!key) return
      const p = parseDriverSlotKey(key)
      if (p.driver) drivers.add(p.driver)
      if (p.time) times.add(p.time)
      if (p.num) nums.add(p.num)
    })
    return {
      drivers: Array.from(drivers).sort((a, b) => a.localeCompare(b)),
      times: Array.from(times).sort(),
      nums: Array.from(nums).sort((a, b) => a - b),
    }
  }, [batchOrders])

  // Filter batch orders by DOW + the three independent batch filters (empty = all)
  const filteredBatchOrders = useMemo(() => batchOrders.filter(o => {
    if (!o.deliveryDate) return false
    const d = String(o.deliveryDate).slice(0, 10)
    if (selectedDOW.length > 0 && !selectedDOW.includes(getDateDOW(d))) return false
    const p = parseDriverSlotKey(formatDriverSlotFromOrder(o))
    if (selectedDrivers.length > 0 && !selectedDrivers.includes(p.driver)) return false
    if (selectedTimes.length > 0 && !selectedTimes.includes(p.time)) return false
    if (selectedBatchNums.length > 0 && !selectedBatchNums.includes(p.num)) return false
    return true
  }), [batchOrders, selectedDOW, selectedDrivers, selectedTimes, selectedBatchNums])

  // Group and sort batches
  const batchGroups = useMemo((): BatchGroup[] => {
    const map = new Map<string, Order[]>()
    filteredBatchOrders.forEach(o => {
      const key = formatDriverSlotFromOrder(o)
      const arr = map.get(key) ?? []
      arr.push(o)
      map.set(key, arr)
    })
    const list = Array.from(map.entries()).map(([batchKey, orders]) => {
      const lines = orders.flatMap(o => Array.isArray(o.lines) ? o.lines as BatchLine[] : [])
      const untaxTotal = lines.reduce((s, l) => s + lineUntax(l), 0)
      const totalWeight = lines.reduce((s, l) => s + lineWeight(l), 0)
      return {
        batchKey,
        orders,
        totalAmount: orders.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0),
        untaxTotal,
        totalWeight,
      }
    })

    if (sortMode === 'driver') {
      list.sort((a, b) => {
        const pa = parseDriverSlotKey(a.batchKey), pb = parseDriverSlotKey(b.batchKey)
        return pa.driver.localeCompare(pb.driver) || (pa.time === pb.time ? pa.num - pb.num : pa.time.localeCompare(pb.time))
      })
    } else if (sortMode === 'time') {
      list.sort((a, b) => {
        const pa = parseDriverSlotKey(a.batchKey), pb = parseDriverSlotKey(b.batchKey)
        const timeCmp = (pa.time === 'am' ? 0 : 1) - (pb.time === 'am' ? 0 : 1)
        return timeCmp || pa.driver.localeCompare(pb.driver) || pa.num - pb.num
      })
    } else {
      list.sort((a, b) => a.batchKey.localeCompare(b.batchKey))
    }
    return list
  }, [filteredBatchOrders, sortMode])

  const grandTotal = batchGroups.reduce((s, g) => s + g.totalAmount, 0)

  // Unassigned orders (no driverSlotId)
  const unassignedOrders = useMemo(() =>
    filteredBatchOrders.filter(o => !(o as unknown as { driverSlotId?: string | null }).driverSlotId && !formatDriverSlotFromOrder(o))
  , [filteredBatchOrders])

  // Map formatted slot string → slot id for passing currentSlotId to BatchCard
  const slotKeyToId = useMemo(() => {
    const map = new Map<string, string>()
    driverSlots.forEach(s => map.set(formatDriverSlot(s), s.id))
    return map
  }, [driverSlots])

  // Refresh batch data after edit
  function refreshBatchOrders() {
    const params = new URLSearchParams({
      include_lines: 'true',
      status: 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED',
      dateField: 'deliveryDate',
      fromDate, toDate,
    })
    apiGet<Order[]>(`/api/orders?${params}`)
      .then(data => setBatchOrders(Array.isArray(data) ? data : []))
      .catch(() => {})
  }

  async function handleTransfer(orderId: string, newSlotId: string) {
    try {
      const slot = driverSlots.find(s => s.id === newSlotId)
      const batch = slot ? formatDriverSlot(slot) : null
      await apiPut(`/api/orders/${orderId}`, { driverSlotId: newSlotId, deliveryBatch: batch })
      refreshBatchOrders()
    } catch (err) {
      alert(err instanceof Error ? err.message : '转移失败')
    }
  }

  async function handleRemove(orderId: string) {
    try {
      await apiPut(`/api/orders/${orderId}`, { driverSlotId: null, deliveryBatch: null })
      refreshBatchOrders()
    } catch (err) {
      alert(err instanceof Error ? err.message : '移除失败')
    }
  }

  function handleLinesUpdated(_orderId: string) {
    refreshBatchOrders()
  }

  async function handleAssignUnassigned(orderId: string, slotId: string) {
    try {
      await apiPut(`/api/orders/${orderId}`, { driverSlotId: slotId })
      refreshBatchOrders()
    } catch (err) {
      alert(err instanceof Error ? err.message : '分配失败')
    }
  }

  function buildUrl(mode: 'day' | 'multiline' | 'summary') {
    const params = new URLSearchParams({ mode, from: fromDate, to: toDate })
    if (selectedCustomers.length > 0) params.set('customerIds', selectedCustomers.map(c => c.id).join(','))
    if (selectedProducts.length > 0) params.set('productNames', selectedProducts.map(p => p.name).join(','))
    if (selectedDrivers.length > 0) params.set('drivers', selectedDrivers.join(','))
    if (selectedTimes.length > 0) params.set('times', selectedTimes.join(','))
    if (selectedBatchNums.length > 0) params.set('batchNums', selectedBatchNums.join(','))
    if (selectedCategory) params.set('categoryId', selectedCategory)
    if (selectedSalesman) params.set('salesman', selectedSalesman)
    return `${prefix}/classic/print/day-wise-report?${params.toString()}`
  }

  // Per-batch dispatch print: prefer the DriverSlot id; fall back to the batch
  // label string for batches that only exist as a legacy deliveryBatch string.
  function handlePrintBatch(batchKey: string, type: 'picking' | 'delivery' | 'summary') {
    const slotId = slotKeyToId.get(batchKey)
    const params = new URLSearchParams({ date: toDate, fromDate })
    if (slotId) params.set('driverSlotId', slotId)
    else params.set('batchLabel', batchKey)
    window.open(`${prefix}/classic/print/dispatch/${type}?${params.toString()}`, '_blank')
  }

  // Close on Escape key
  const handleClose = useCallback(onClose, [onClose])
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose])

  const selectCls = 'flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400'
  const tabCls = (active: boolean) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      active
        ? 'border-[#875A7B] text-[#875A7B]'
        : 'border-transparent text-gray-400 hover:text-gray-600 hover:border-gray-300'
    }`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 h-[92vh] flex flex-col">

        {/* Header + Tabs */}
        <div className="shrink-0 border-b border-gray-200">
          <div className="flex items-center justify-between px-6 pt-4 pb-2">
            <h2 className="text-base font-bold text-gray-900">批次管理 &amp; 打印中心</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
          </div>
          <div className="flex px-6">
            <button className={tabCls(tab === 'batch')} onClick={() => setTab('batch')}>
              批次分析
            </button>
            <button className={tabCls(tab === 'report')} onClick={() => setTab('report')}>
              Day Wise Product Sales Report
            </button>
          </div>
        </div>

        {/* Filter grid (shared between tabs) */}
        <div className="p-5 border-b border-gray-200 shrink-0 space-y-3">
          {/* Dates + report-only selects */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <div className="flex items-center gap-3">
              <label className="w-32 text-xs text-gray-500 shrink-0">From</label>
              <input type="date" value={fromDate} max={toDate}
                onChange={e => setFromDate(e.target.value)}
                className={selectCls} />
            </div>
            <div className="flex items-center gap-3">
              <label className="w-36 text-xs text-gray-500 shrink-0">To</label>
              <input type="date" value={toDate} min={fromDate}
                onChange={e => setToDate(e.target.value)}
                className={selectCls} />
            </div>
            {tab === 'report' && (
              <>
                <div className="flex items-center gap-3">
                  <label className="w-32 text-xs text-gray-500 shrink-0">Salesman</label>
                  <select value={selectedSalesman}
                    onChange={e => setSelectedSalesman(e.target.value)}
                    className={selectCls}>
                    <option value="">全部业务员</option>
                    {allSalesmen.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <label className="w-36 text-xs text-gray-500 shrink-0">Product Category</label>
                  <select value={selectedCategory}
                    onChange={e => setSelectedCategory(e.target.value)}
                    className={selectCls}>
                    <option value="">全部分类</option>
                    {allCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>

          {/* 司机 / AM-PM / 批次 — three independent multi-select filters (留空 = 全部) */}
          <div className="space-y-2 pt-2 border-t border-dashed border-gray-100">
            <div className="flex items-start gap-3">
              <label className="w-32 text-xs text-gray-500 shrink-0 pt-1.5">司机</label>
              <ChipMultiSelect
                options={batchFilterOptions.drivers}
                selected={selectedDrivers}
                onToggle={v => setSelectedDrivers(prev => toggleValue(prev, v))}
                onClear={() => setSelectedDrivers([])}
                allLabel="全部司机"
              />
            </div>
            <div className="flex items-start gap-3">
              <label className="w-32 text-xs text-gray-500 shrink-0 pt-1.5">AM / PM</label>
              <ChipMultiSelect
                options={batchFilterOptions.times}
                selected={selectedTimes}
                onToggle={v => setSelectedTimes(prev => toggleValue(prev, v))}
                onClear={() => setSelectedTimes([])}
                renderLabel={t => t.toUpperCase()}
                allLabel="全部时段"
              />
            </div>
            <div className="flex items-start gap-3">
              <label className="w-32 text-xs text-gray-500 shrink-0 pt-1.5">批次</label>
              <ChipMultiSelect
                options={batchFilterOptions.nums}
                selected={selectedBatchNums}
                onToggle={v => setSelectedBatchNums(prev => toggleValue(prev, v))}
                onClear={() => setSelectedBatchNums([])}
                renderLabel={n => `#${n}`}
                allLabel="全部批次"
              />
            </div>
          </div>

          {/* 按星期筛选 (batch tab only) */}
          {tab === 'batch' && (
            <div className="flex items-start gap-3 pt-1">
              <label className="w-32 text-xs text-gray-500 shrink-0 pt-1.5">按星期筛选</label>
              <div className="flex gap-1.5 flex-wrap">
                {WEEKDAYS.map((label, dow) => {
                  const active = selectedDOW.includes(dow)
                  return (
                    <button key={dow}
                      onClick={() => setSelectedDOW(prev => active ? prev.filter(d => d !== dow) : [...prev, dow])}
                      className="px-2.5 py-1 text-xs rounded-full border transition-colors"
                      style={active ? { background: '#875A7B', color: '#fff', borderColor: '#875A7B' }
                        : { background: '#fff', color: '#875A7B', borderColor: '#d4b8d0' }}
                    >{label}</button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1">

          {tab === 'batch' && (
            <div className="p-4 space-y-3">
              {/* Sort bar & summary */}
              {!batchLoading && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">共 {batchGroups.length} 个批次，{filteredBatchOrders.length} 单</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">排序：</span>
                    {([['batch', '批次'], ['time', 'AM/PM'], ['driver', '司机']] as [BatchSortMode, string][]).map(([mode, label]) => (
                      <button key={mode} onClick={() => setSortMode(mode)}
                        className="px-3 py-1 text-xs rounded-full border transition-colors"
                        style={sortMode === mode
                          ? { background: '#875A7B', color: '#fff', borderColor: '#875A7B' }
                          : { background: '#fff', color: '#875A7B', borderColor: '#d4b8d0' }}
                      >{label}</button>
                    ))}
                    <span className="font-semibold ml-2" style={{ color: '#875A7B' }}>合计 €{fmtMoney(grandTotal)}</span>
                  </div>
                </div>
              )}

              {batchLoading ? (
                <div className="text-center py-12 text-gray-400 text-sm">加载中…</div>
              ) : batchGroups.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm border rounded-lg bg-white" style={{ borderColor: '#d4b8d0' }}>
                  {batchFetched ? '该日期范围内没有订单' : ''}
                </div>
              ) : (
                <div className="space-y-2">
                  {unassignedOrders.length > 0 && (
                    <UnassignedOrdersPanel
                      orders={unassignedOrders}
                      driverSlots={driverSlots}
                      onAssign={handleAssignUnassigned}
                    />
                  )}
                  {batchGroups.map(g => (
                    <BatchCard
                      key={g.batchKey}
                      group={g}
                      customerMap={customerMap}
                      driverSlots={driverSlots}
                      currentSlotId={slotKeyToId.get(g.batchKey)}
                      onTransfer={handleTransfer}
                      onRemove={handleRemove}
                      onLinesUpdated={handleLinesUpdated}
                      onPrint={handlePrintBatch}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'report' && (
            <>
              {/* Customers table */}
              <div className="border-b border-gray-200">
                <div className="px-5 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Customers</span>
                  {selectedCustomers.length === 0 && (
                    <span className="ml-2 text-xs text-gray-400">（留空 = 全部客户）</span>
                  )}
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-8" />
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Name</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Street</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">City</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Notes</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Pricelist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedCustomers.map(c => (
                      <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2 text-center">
                          <button type="button"
                            onClick={() => setSelectedCustomers(prev => prev.filter(x => x.id !== c.id))}
                            className="text-gray-300 hover:text-red-400 text-base leading-none">×</button>
                        </td>
                        <td className="px-4 py-2 text-gray-800">{c.name}</td>
                        <td className="px-4 py-2 text-gray-400">{c.street ?? '–'}</td>
                        <td className="px-4 py-2 text-gray-400">{c.city ?? '–'}</td>
                        <td className="px-4 py-2 text-gray-400">{c.notes ?? '–'}</td>
                        <td className="px-4 py-2 text-gray-400">{c.pricelist ?? '–'}</td>
                      </tr>
                    ))}
                    <InlineSearch
                      allItems={allCustomers}
                      selectedIds={selectedCustomers.map(c => c.id)}
                      onAdd={item => setSelectedCustomers(prev => [...prev, item])}
                      placeholder="搜索客户…"
                      colSpan={5}
                    />
                  </tbody>
                </table>
              </div>

              {/* Products table */}
              <div className="border-b border-gray-200">
                <div className="px-5 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Products</span>
                  {selectedProducts.length === 0 && (
                    <span className="ml-2 text-xs text-gray-400">（留空 = 全部商品）</span>
                  )}
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-8" />
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Name</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-400">Sale Price</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedProducts.map(p => (
                      <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2 text-center">
                          <button type="button"
                            onClick={() => setSelectedProducts(prev => prev.filter(x => x.id !== p.id))}
                            className="text-gray-300 hover:text-red-400 text-base leading-none">×</button>
                        </td>
                        <td className="px-4 py-2 text-gray-800">{p.name}</td>
                        <td className="px-4 py-2 text-right text-gray-600">
                          {p.salePrice != null ? `€${Number(p.salePrice).toFixed(2)}` : '–'}
                        </td>
                        <td className="px-4 py-2 text-gray-400">{p.category ?? '–'}</td>
                      </tr>
                    ))}
                    <InlineSearch
                      allItems={allProducts}
                      selectedIds={selectedProducts.map(p => p.id)}
                      onAdd={item => setSelectedProducts(prev => [...prev, item])}
                      placeholder="搜索商品…"
                      colSpan={3}
                    />
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* ── Footer buttons ── */}
        <div className="px-6 py-4 border-t border-gray-200 shrink-0 bg-white rounded-b-xl space-y-3">
          {/* Batch tab: dispatch printing now lives on each batch card */}
          {tab === 'batch' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="shrink-0">配送日期: {toDate}</span>
              <span className="italic">— 拣货单 / 订单 / 送货汇总单 请在对应批次行右侧点击打印</span>
            </div>
          )}

          {/* Report tab: report print buttons */}
          {tab === 'report' && (
            <div className="flex items-center gap-3">
              <button onClick={() => window.open(buildUrl('day'), '_blank')}
                className="px-5 py-2 text-sm font-semibold text-white rounded"
                style={{ background: '#875A7B' }}>
                Print
              </button>
              <button onClick={() => window.open(buildUrl('multiline'), '_blank')}
                className="px-5 py-2 text-sm font-semibold rounded border"
                style={{ borderColor: '#875A7B', color: '#875A7B' }}>
                Print Multi Line
              </button>
              <button onClick={() => window.open(buildUrl('summary'), '_blank')}
                className="px-5 py-2 text-sm font-semibold rounded border border-gray-300 text-gray-600">
                Print Sale Summary
              </button>
            </div>
          )}

          {/* Cancel */}
          <div className="flex justify-end">
            <button onClick={onClose}
              className="px-5 py-2 text-sm text-gray-400 hover:text-gray-600">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
