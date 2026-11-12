'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import type { Order } from '@/lib/types'

/**
 * 退货/报废整合 M3：日销售中心「退货登记」tab（跟打印中心/缺货处理平级，不嵌进缺货处理——
 * 缺货是发货前事件、退货是发货后事件，混在一起以后排查分不清是哪种原因）。
 *
 * 按订单号/客户搜到订单 → 选订单行 → 填数量+原因+退货/换货 → 提交，创建一条 WAREHOUSE_PENDING
 * 状态的 OrderReturn 记录，后续核实/审核走 operator/inventory「退换货」tab 同一套看板，这里只管登记。
 */

interface RegisterForm {
  quantity: string
  reason: string
  actionType: 'return' | 'exchange'
  exchangeOrderId: string
}

interface RegisteredReturn {
  orderLineId: string | null
  productId: string
  quantity: number
  status: string
}

const EMPTY_FORM: RegisterForm = { quantity: '', reason: '', actionType: 'return', exchangeOrderId: '' }

export default function ReturnRegistration({ refreshKey }: { refreshKey: number }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order | null>(null)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [form, setForm] = useState<RegisterForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [registeredReturns, setRegisteredReturns] = useState<RegisteredReturn[]>([])

  async function runSearch() {
    const q = query.trim()
    if (!q) { setResults([]); return }
    setSearching(true)
    try {
      const [byCode, byCustomer] = await Promise.all([
        apiGet<{ data: Order[] }>(`/api/orders?colCode=${encodeURIComponent(q)}&include_lines=true&pageSize=20`),
        apiGet<{ data: Order[] }>(`/api/orders?colCustomer=${encodeURIComponent(q)}&include_lines=true&pageSize=20`),
      ])
      const merged = new Map<string, Order>()
      for (const o of [...byCode.data, ...byCustomer.data]) {
        // lib/types.ts 的 OrderStatus 类型声明是小写，但 Prisma 枚举/数据库实际存的是大写
        // （IN_DELIVERY/COMPLETED），后端 /api/order-returns 也按大写校验——这里跟它对齐，
        // 不信前端类型声明
        if (['IN_DELIVERY', 'COMPLETED'].includes(String(o.status))) merged.set(o.id, o)
      }
      setResults(Array.from(merged.values()))
    } catch {
      toast.error(isEn ? 'Search failed' : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  async function selectOrder(o: Order) {
    setSelected(o)
    setActiveLineId(null)
    setForm(EMPTY_FORM)
    setRegisteredReturns([])
    try {
      const result = await apiGet<{ returns: RegisteredReturn[] }>(`/api/order-returns?orderId=${encodeURIComponent(o.id)}`)
      setRegisteredReturns(result.returns.filter(row => row.status === 'WAREHOUSE_PENDING' || row.status === 'PENDING_REVIEW'))
    } catch (err) {
      setSelected(null)
      toast.error(err instanceof Error ? err.message : (isEn ? 'Could not load registered returns' : '读取已有退货登记失败'))
    }
  }

  function reservedReturnQty(line: NonNullable<Order['lines']>[number]) {
    // Unlinked historical records (created before line-level linkage) are
    // conservatively attributed by order + product.
    const reserved = registeredReturns
      .filter(row => row.productId === line.productId && (!row.orderLineId || row.orderLineId === line.id))
      .reduce((sum, row) => sum + Number(row.quantity), 0)
    return reserved
  }

  function returnableQty(line: NonNullable<Order['lines']>[number]) {
    return Math.max(0, Number(line.deliveredQty ?? 0) - reservedReturnQty(line))
  }

  function openLine(lineId: string) {
    setActiveLineId(lineId)
    setForm(EMPTY_FORM)
  }

  async function submit() {
    if (!selected || !activeLineId) return
    const line = selected.lines?.find(l => l.id === activeLineId)
    if (!line) return
    const quantity = Number(form.quantity)
    if (!quantity || quantity <= 0) {
      toast.error(isEn ? 'Enter a quantity > 0' : '请填写大于 0 的数量')
      return
    }
    const remaining = returnableQty(line)
    if (quantity > remaining + 0.000001) {
      toast.error(isEn ? `Only ${remaining} ${line.uomName ?? ''} remains returnable` : `该商品最多还能登记 ${remaining} ${line.uomName ?? ''}`)
      return
    }
    setSubmitting(true)
    try {
      const created = await apiPost<RegisteredReturn>('/api/order-returns', {
        orderId: selected.id,
        orderLineId: line.id,
        productId: line.productId,
        quantity,
        reason: form.reason.trim() || undefined,
        actionType: form.actionType,
        exchangeOrderId: form.actionType === 'exchange' ? form.exchangeOrderId.trim() || undefined : undefined,
      })
      toast.success(isEn ? 'Return registered' : '登记成功，待仓库核实')
      setRegisteredReturns(prev => [...prev, created])
      setActiveLineId(null)
      setForm(EMPTY_FORM)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Registration failed' : '登记失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="w-full max-w-none">
      <div className="flex gap-2 mb-4">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
          placeholder={isEn ? 'Order code or customer name' : '订单号或客户名'}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-[#875A7B]"
        />
        <button
          onClick={runSearch}
          disabled={searching}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
          style={{ background: '#875A7B' }}
        >
          {isEn ? 'Search' : '搜索'}
        </button>
      </div>

      {!selected && results.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-50">
          {results.map(o => (
            <button
              key={o.id}
              onClick={() => selectOrder(o)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50"
            >
              <span className="text-xs font-mono text-gray-500 w-32">{o.code ?? o.id.slice(-6)}</span>
              <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
              <span className="text-xs text-gray-400">{o.deliveryDate ?? ''}</span>
            </button>
          ))}
        </div>
      )}
      {!selected && !searching && query && results.length === 0 && (
        <p className="text-sm text-gray-400">{isEn ? 'No matching delivered orders' : '没有匹配到已发货订单'}</p>
      )}

      {selected && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div>
              <span className="text-sm font-medium text-gray-900">{selected.code}</span>
              <span className="text-sm text-gray-500 ml-2">{selected.restaurantName}</span>
            </div>
            <button
              onClick={() => { setSelected(null); setResults([]); setQuery('') }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              {isEn ? '← Back to search' : '← 重新搜索'}
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {(selected.lines ?? []).map(line => (
              <div key={line.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-gray-800">{line.productName}</span>
                  <span className="text-xs text-gray-400 w-44 text-right">
                    {isEn ? 'Delivered' : '已送达'} {line.deliveredQty} · {isEn ? 'Returnable' : '可登记'} {returnableQty(line)} {line.uomName ?? ''}
                  </span>
                  {returnableQty(line) <= 0 ? (
                    <span className={`text-xs w-20 text-right ${reservedReturnQty(line) > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                      {reservedReturnQty(line) > 0 ? (isEn ? 'Registered' : '已登记') : (isEn ? 'No delivered qty' : '无已送达数量')}
                    </span>
                  ) : (
                    <button
                      onClick={() => openLine(line.id)}
                      className="text-xs text-[#875A7B] hover:underline w-16 text-right"
                    >
                      {isEn ? 'Register' : '登记退货'}
                    </button>
                  )}
                </div>
                {activeLineId === line.id && (
                  <div className="mt-2.5 pl-2 border-l-2 border-gray-100 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-20">{isEn ? 'Quantity' : '数量'}</label>
                      <input
                        type="number"
                        min={0.001}
                        max={returnableQty(line)}
                        step="0.01"
                        value={form.quantity}
                        onChange={e => {
                          const next = e.target.value
                          if (next === '' || Number(next) <= returnableQty(line)) setForm(f => ({ ...f, quantity: next }))
                        }}
                        className="w-28 px-2 py-1 border border-gray-300 rounded text-sm"
                        placeholder={String(returnableQty(line))}
                      />
                      <span className="text-xs text-gray-400">{line.uomName ?? ''}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-20">{isEn ? 'Type' : '类型'}</label>
                      <select
                        value={form.actionType}
                        onChange={e => setForm(f => ({ ...f, actionType: e.target.value as 'return' | 'exchange' }))}
                        className="px-2 py-1 border border-gray-300 rounded text-sm"
                      >
                        <option value="return">{isEn ? 'Return' : '退货'}</option>
                        <option value="exchange">{isEn ? 'Exchange' : '换货'}</option>
                      </select>
                    </div>
                    {form.actionType === 'exchange' && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-500 w-20">{isEn ? 'New order' : '新订单号'}</label>
                        <input
                          value={form.exchangeOrderId}
                          onChange={e => setForm(f => ({ ...f, exchangeOrderId: e.target.value }))}
                          className="w-40 px-2 py-1 border border-gray-300 rounded text-sm"
                          placeholder={isEn ? 'Optional' : '可选'}
                        />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-20">{isEn ? 'Reason' : '原因'}</label>
                      <input
                        value={form.reason}
                        onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                        className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                        placeholder={isEn ? 'Optional' : '可选'}
                      />
                    </div>
                    <div className="flex gap-2 mt-1">
                      <button
                        onClick={submit}
                        disabled={submitting || returnableQty(line) <= 0}
                        className="px-3 py-1 rounded text-xs font-medium text-white disabled:opacity-50"
                        style={{ background: '#875A7B' }}
                      >
                        {isEn ? 'Submit' : '提交登记'}
                      </button>
                      <button
                        onClick={() => setActiveLineId(null)}
                        className="px-3 py-1 rounded text-xs text-gray-500 hover:bg-gray-100"
                      >
                        {isEn ? 'Cancel' : '取消'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {(selected.lines ?? []).length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-400">{isEn ? 'No lines on this order' : '该订单没有商品行'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
