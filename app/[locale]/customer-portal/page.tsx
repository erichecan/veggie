'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

interface Product {
  id: string
  name: string
  spec: string | null
  uomName: string | null
  customerPrice: number | null
  priceSource: string | null
  categoryId: string | null
  internalRef: string | null
  images: string[]
}

interface CartItem {
  productId: string
  name: string
  spec: string | null
  uomName: string | null
  price: number
  quantity: number
}

interface FrequentItem {
  productId: string
  orderCount: number
  lastQuantity: number
  lastOrderedAt: string
}

function loadCart(): CartItem[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem('veggie_cart') || '[]')
  } catch { return [] }
}

function saveCart(items: CartItem[]) {
  localStorage.setItem('veggie_cart', JSON.stringify(items))
}

export default function CustomerProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [frequent, setFrequent] = useState<FrequentItem[]>([])
  const [cart, setCart] = useState<CartItem[]>(loadCart)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showCart, setShowCart] = useState(false)
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'ONLINE'>('CASH')
  const [note, setNote] = useState('')

  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    apiGet<{ products: Product[] }>('/api/customer-portal/products')
      .then(d => setProducts(d.products || []))
      .catch(() => toast.error('加载商品失败'))
      .finally(() => setLoading(false))
    apiGet<FrequentItem[]>('/api/customer-portal/frequently-ordered')
      .then(setFrequent)
      .catch(() => {}) // 常购清单是锦上添花，加载失败不影响正常下单
  }, [])

  const updateCart = useCallback((newCart: CartItem[]) => {
    setCart(newCart)
    saveCart(newCart)
  }, [])

  function addToCart(p: Product, qty = 1) {
    const existing = cart.find(c => c.productId === p.id)
    if (existing) {
      updateCart(cart.map(c => c.productId === p.id ? { ...c, quantity: c.quantity + qty } : c))
    } else {
      updateCart([...cart, {
        productId: p.id,
        name: p.name,
        spec: p.spec,
        uomName: p.uomName,
        price: p.customerPrice ?? 0,
        quantity: qty,
      }])
    }
    toast.success(`已添加 ${p.name}`)
  }

  function setQty(productId: string, qty: number) {
    if (qty <= 0) {
      updateCart(cart.filter(c => c.productId !== productId))
    } else {
      updateCart(cart.map(c => c.productId === productId ? { ...c, quantity: qty } : c))
    }
  }

  function removeFromCart(productId: string) {
    updateCart(cart.filter(c => c.productId !== productId))
  }

  async function placeOrder() {
    if (cart.length === 0) { toast.error('购物车为空'); return }
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        items: cart.map(c => ({ productId: c.productId, quantity: c.quantity, price: c.price })),
        paymentMethod,
      }
      if (deliveryDate) body.deliveryDate = deliveryDate
      if (note.trim()) body.internalNote = note.trim()

      const res = await apiPost<{ id: string; code: string; totalAmount: number }>('/api/customer-portal/orders', body)
      toast.success(`下单成功！订单号: ${res.code}，金额: ${eur(res.totalAmount)}`)
      updateCart([])
      setShowCart(false)
      setNote('')
      router.push(`${prefix}/customer-portal/orders/${res.id}`)
    } catch (e: unknown) {
      toast.error((e as Error).message || '下单失败')
    } finally {
      setSubmitting(false)
    }
  }

  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)
  const frequentProducts = frequent
    .map(f => {
      const p = products.find(pp => pp.id === f.productId)
      return p ? { ...p, lastQuantity: f.lastQuantity } : null
    })
    .filter((p): p is Product & { lastQuantity: number } => p !== null && p.customerPrice != null)
  const filtered = search
    ? products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.spec && p.spec.toLowerCase().includes(search.toLowerCase())))
    : products

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const minDate = tomorrow.toISOString().slice(0, 10)

  if (loading) return <div className="text-center py-20 text-gray-400">加载商品中...</div>

  return (
    <div className="space-y-4">
      {/* Search + Cart toggle */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索商品名称..."
            className="w-full border rounded-lg px-4 py-2.5 text-sm pr-8 focus:outline-none focus:ring-2"
            style={{ borderColor: '#ddd', focusRingColor: PURPLE } as React.CSSProperties}
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600">✕</button>
          )}
        </div>
        <button onClick={() => setShowCart(!showCart)}
          className="relative px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
          style={{ background: PURPLE }}>
          🛒 购物车
          {cartCount > 0 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {cartCount}
            </span>
          )}
        </button>
      </div>

      {/* 常购清单：按历史下单次数排序，支持一键快捷复购 */}
      {frequentProducts.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-gray-700">🔁 常购清单</h2>
          <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
            {frequentProducts.map(p => (
              <div key={p.id} className="flex-none w-40 bg-white rounded-xl border p-3 flex flex-col justify-between">
                <div>
                  <h3 className="font-medium text-sm truncate">{p.name}</h3>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    上次 {p.lastQuantity} {p.uomName || '个'}
                  </p>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm font-bold" style={{ color: PURPLE }}>{eur(p.customerPrice ?? 0)}</span>
                  <button onClick={() => addToCart(p, p.lastQuantity)}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium text-white transition-colors"
                    style={{ background: PURPLE }}>
                    一键复购
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cart panel */}
      {showCart && (
        <div className="bg-white rounded-xl shadow-lg border p-5 space-y-4">
          <h2 className="font-bold text-lg" style={{ color: PURPLE }}>🛒 购物车</h2>
          {cart.length === 0 ? (
            <p className="text-gray-400 text-sm py-4 text-center">购物车为空，请先添加商品</p>
          ) : (
            <>
              <div className="divide-y">
                {cart.map(c => (
                  <div key={c.productId} className="flex items-center justify-between py-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{c.name}</p>
                      <p className="text-xs text-gray-400">{c.spec} · {c.uomName} · {eur(c.price)}</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <button onClick={() => setQty(c.productId, c.quantity - 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">−</button>
                      <input type="number" value={c.quantity} min={0} step={0.5}
                        onChange={e => setQty(c.productId, parseFloat(e.target.value) || 0)}
                        className="w-14 text-center border rounded text-sm py-1" />
                      <button onClick={() => setQty(c.productId, c.quantity + 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">+</button>
                      <span className="text-sm font-medium w-16 text-right">{eur(c.price * c.quantity)}</span>
                      <button onClick={() => removeFromCart(c.productId)} className="text-red-400 hover:text-red-600 text-sm ml-1">✕</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t pt-3 space-y-3">
                <div className="flex justify-between font-bold text-lg">
                  <span>合计</span>
                  <span style={{ color: PURPLE }}>{eur(cartTotal)}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">配送日期</label>
                    <input type="date" value={deliveryDate} min={minDate}
                      onChange={e => setDeliveryDate(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">付款方式</label>
                    <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as 'CASH' | 'ONLINE')}
                      className="w-full border rounded px-3 py-2 text-sm">
                      <option value="CASH">现金</option>
                      <option value="ONLINE">在线支付</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">备注（最多30字）</label>
                  <input type="text" value={note} onChange={e => setNote(e.target.value.slice(0, 30))}
                    placeholder="如有特殊要求请备注"
                    className="w-full border rounded px-3 py-2 text-sm" />
                </div>
                <button onClick={placeOrder} disabled={submitting || cart.length === 0}
                  className="w-full py-3 rounded-lg text-white font-medium disabled:opacity-50 transition-colors"
                  style={{ background: PURPLE }}>
                  {submitting ? '提交中...' : `确认下单 (${eur(cartTotal)})`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Product grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(p => {
          const inCart = cart.find(c => c.productId === p.id)
          return (
            <div key={p.id} className="bg-white rounded-xl border p-4 flex flex-col justify-between hover:shadow-md transition-shadow">
              <div>
                <h3 className="font-medium text-sm">{p.name}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {p.spec && <span>{p.spec} · </span>}
                  {p.uomName || '个'}
                  {p.internalRef && <span> · {p.internalRef}</span>}
                </p>
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="text-lg font-bold" style={{ color: PURPLE }}>
                  {p.customerPrice != null ? eur(p.customerPrice) : '询价'}
                </span>
                {p.customerPrice != null ? (
                  inCart ? (
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setQty(p.id, (inCart.quantity) - 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">−</button>
                      <span className="text-sm font-medium w-8 text-center">{inCart.quantity}</span>
                      <button onClick={() => setQty(p.id, (inCart.quantity) + 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">+</button>
                    </div>
                  ) : (
                    <button onClick={() => addToCart(p)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
                      style={{ background: PURPLE }}>
                      加入购物车
                    </button>
                  )
                ) : (
                  <span className="text-xs text-gray-400">暂无报价</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {filtered.length === 0 && !loading && (
        <div className="text-center py-16 text-gray-400">
          {search ? `没有找到 "${search}" 相关商品` : '暂无商品'}
        </div>
      )}
    </div>
  )
}
