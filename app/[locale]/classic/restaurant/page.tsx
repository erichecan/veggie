'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiPost, apiGet } from '@/lib/api'
import { getSession } from '@/lib/session'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import type { Product, CartItem, Customer, OdooPricelist, PaymentMethod } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

const PURPLE = '#875A7B'
const PAGE_SIZE = 20

const TAX_RATE_OPTIONS = [
  { label: '0%', value: 0 },
  { label: '13.5%', value: 0.135 },
  { label: '23%', value: 0.23 },
]

function getDefaultTaxRate(p: Product | undefined): number {
  if (!p) return 0
  const rate = p.customerTaxRate ?? 0
  const supported = TAX_RATE_OPTIONS.find(o => Math.abs(o.value - rate) < 1e-9)
  return supported ? supported.value : 0
}

export default function ClassicRestaurantPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [products, setProducts] = useState<Product[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [allPricelists, setAllPricelists] = useState<OdooPricelist[]>([])
  const [restaurantId, setRestaurantId] = useState<string>('')
  const [page, setPage] = useState(1)
  const [cart, setCart] = useState<CartItem[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('online')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const user = getSession()
    if (user) {
      const cid = user.customerId ?? user.userId
      setRestaurantId(cid)
      apiGet<Customer[]>('/api/customers')
        .then(cs => { const found = cs.find(c => c.id === cid); if (found) setCustomer(found) })
        .catch(() => {})
    }
    apiGet<Product[]>('/api/products')
      .then(ps => { setProducts(ps.filter(p => (p.status as string).toLowerCase() === 'active')); setPage(1) })
      .catch(() => {})
    apiGet<OdooPricelist[]>('/api/pricelists')
      .then(setAllPricelists)
      .catch(() => {})
    const saved = sessionStorage.getItem('cart')
    if (saved) setCart(JSON.parse(saved))
  }, [])

  function saveCart(items: CartItem[]) {
    setCart(items)
    sessionStorage.setItem('cart', JSON.stringify(items))
  }

  function getDisplayPrice(p: Product, qty = 1): number {
    if (!customer) return p.listPrice ?? p.price ?? 0
    return resolveCustomerPrice(p, customer, allPricelists, qty).price
  }

  function addToCart(p: Product) {
    const existing = cart.find(c => c.productId === p.id)
    if (existing) {
      saveCart(cart.map(c => c.productId === p.id ? { ...c, quantity: c.quantity + 1 } : c))
    } else {
      const price = getDisplayPrice(p)
      saveCart([...cart, {
        productId: p.id,
        productName: p.name,
        spec: p.spec ?? '',
        price,
        image: p.images[0] ?? '',
        quantity: 1,
        taxRate: getDefaultTaxRate(p),
      }])
    }
    toast.success(`${p.name} 已加入购物车`)
  }

  function updateQty(productId: string, qty: number) {
    if (qty <= 0) {
      saveCart(cart.filter(c => c.productId !== productId))
    } else {
      saveCart(cart.map(c => c.productId === productId ? { ...c, quantity: qty } : c))
    }
  }

  function updateTaxRate(productId: string, rate: number) {
    saveCart(cart.map(c => c.productId === productId ? { ...c, taxRate: rate } : c))
  }

  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0)

  async function handlePay() {
    if (submitting) return
    const user = getSession()
    if (!user) return
    setSubmitting(true)
    const cid = user.customerId ?? user.userId
    const orderPayload = {
      restaurantId: cid,
      restaurantName: user.name,
      items: cart.map(c => {
        const product = products.find(p => p.id === c.productId)
        const taxRate = c.taxRate ?? getDefaultTaxRate(product)
        return {
          productId: c.productId,
          productName: c.productName,
          spec: c.spec,
          price: c.price,
          quantity: Math.max(0.001, Number(c.quantity)),
          subtotal: c.price * c.quantity,
          taxRate,
        }
      }),
      totalAmount: total,
      status: 'pending',
      paymentMethod,
    }
    try {
      await apiPost('/api/orders', orderPayload)
      saveCart([])
      sessionStorage.removeItem('cart')
      setPayOpen(false)
      toast.success('付款成功！订单已生成')
      router.push(`${prefix}/classic/restaurant/orders`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下单失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)

  const totalPages = Math.ceil(products.length / PAGE_SIZE)
  const pageProducts = products.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">商品选购</h1>
        <Button
          onClick={() => setCartOpen(true)}
          style={{ background: PURPLE }}
          className="text-white hover:opacity-90 relative"
        >
          🛒 购物车
          {cartCount > 0 && (
            <span className="ml-2 bg-white rounded-full text-xs font-bold px-1.5" style={{ color: PURPLE }}>
              {cartCount}
            </span>
          )}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {pageProducts.map(p => {
          const inCart = cart.find(c => c.productId === p.id)
          const displayPrice = getDisplayPrice(p)
          const listPrice = p.listPrice ?? p.price ?? 0
          const hasDiscount = displayPrice < listPrice
          return (
            <div key={p.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
              <div className="aspect-[4/3] bg-gray-100 overflow-hidden">
                <img
                  src={p.images[0] || '/placeholder.svg'}
                  alt={p.name}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement
                    if (!el.src.endsWith('/placeholder.svg')) el.src = '/placeholder.svg'
                  }}
                />
              </div>
              <div className="p-3">
                <h3 className="font-medium text-gray-900 truncate">{p.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5">{p.spec}</p>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-bold" style={{ color: PURPLE }}>€{displayPrice.toFixed(2)}</span>
                  {hasDiscount && (
                    <span className="text-gray-400 line-through text-xs">€{listPrice.toFixed(2)}</span>
                  )}
                </div>
                <div className="mt-3">
                  {inCart ? (
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => updateQty(p.id, inCart.quantity - 1)}
                        className="w-7 h-7 rounded-full flex items-center justify-center font-bold"
                        style={{ background: '#f3eff5', color: PURPLE }}
                      >-</button>
                      <span className="font-medium">{inCart.quantity}</span>
                      <button
                        onClick={() => updateQty(p.id, inCart.quantity + 1)}
                        className="w-7 h-7 rounded-full text-white flex items-center justify-center font-bold"
                        style={{ background: PURPLE }}
                      >+</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => addToCart(p)}
                      className="w-full py-1.5 rounded-lg text-sm font-medium transition-colors border"
                      style={{ background: '#f3eff5', color: PURPLE, borderColor: '#d4c0d4' }}
                    >
                      加入购物车
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-6">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-600 disabled:opacity-40 hover:border-gray-400 transition-colors"
          >
            上一页
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(n => (
            <button
              key={n}
              onClick={() => setPage(n)}
              className="w-8 h-8 text-sm rounded border transition-colors"
              style={n === page
                ? { background: PURPLE, color: 'white', borderColor: PURPLE }
                : { background: 'white', color: '#374151', borderColor: '#e5e7eb' }}
            >
              {n}
            </button>
          ))}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-600 disabled:opacity-40 hover:border-gray-400 transition-colors"
          >
            下一页
          </button>
        </div>
      )}

      {/* 购物车弹窗 */}
      <Dialog open={cartOpen} onOpenChange={setCartOpen}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>购物车</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {cart.length === 0 && (
              <p className="text-center py-8 text-gray-400">购物车是空的</p>
            )}
            {cart.map(item => {
              const product = products.find(p => p.id === item.productId)
              const currentTaxRate = item.taxRate ?? getDefaultTaxRate(product)
              return (
                <div key={item.productId} className="py-3">
                  <div className="flex items-center gap-3">
                    <img src={item.image || '/placeholder.svg'} alt={item.productName} className="w-12 h-12 rounded object-cover bg-gray-100" onError={(e) => { const el = e.currentTarget as HTMLImageElement; if (!el.src.endsWith('/placeholder.svg')) el.src = '/placeholder.svg' }} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{item.productName}</p>
                      <p className="text-xs text-gray-500">{item.spec}</p>
                      <p className="text-sm font-medium" style={{ color: PURPLE }}>€{item.price}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => updateQty(item.productId, item.quantity - 1)} className="w-6 h-6 rounded bg-gray-100 text-gray-600 flex items-center justify-center text-sm">-</button>
                      <span className="w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <button onClick={() => updateQty(item.productId, item.quantity + 1)} className="w-6 h-6 rounded text-white flex items-center justify-center text-sm" style={{ background: PURPLE }}>+</button>
                    </div>
                    <span className="w-16 text-right text-sm font-medium">€{(item.price * item.quantity).toFixed(1)}</span>
                  </div>
                  <div className="mt-1.5 ml-[60px] flex items-center gap-1">
                    <span className="text-xs text-gray-400">税率:</span>
                    <select
                      value={currentTaxRate}
                      onChange={e => updateTaxRate(item.productId, parseFloat(e.target.value))}
                      aria-label={`${item.productName} 税率`}
                      className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1"
                      style={{ outlineColor: PURPLE }}
                    >
                      {TAX_RATE_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="border-t pt-3 mt-1">
            <div className="flex justify-between items-center mb-3">
              <span className="font-medium text-gray-700">合计</span>
              <span className="text-xl font-bold" style={{ color: PURPLE }}>€{total.toFixed(2)}</span>
            </div>
            <Button
              className="w-full text-white hover:opacity-90"
              style={{ background: PURPLE }}
              disabled={cart.length === 0}
              onClick={() => { setCartOpen(false); setPayOpen(true) }}
            >
              提交订单
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 付款确认弹窗 */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader>
            <DialogTitle>确认付款</DialogTitle>
          </DialogHeader>
          <div className="py-6">
            <p className="text-4xl font-bold mb-2" style={{ color: PURPLE }}>€{total.toFixed(2)}</p>
            <p className="text-gray-500 text-sm">{cart.length} 种商品，共 {cartCount} 件</p>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setPaymentMethod('online')}
                className="flex-1 py-3 rounded-xl border-2 text-sm font-medium transition-colors"
                style={paymentMethod === 'online'
                  ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
                  : { borderColor: '#e5e7eb', color: '#6b7280' }}
              >
                💳 线上支付
              </button>
              <button
                onClick={() => setPaymentMethod('cash')}
                className="flex-1 py-3 rounded-xl border-2 text-sm font-medium transition-colors"
                style={paymentMethod === 'cash'
                  ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
                  : { borderColor: '#e5e7eb', color: '#6b7280' }}
              >
                💵 司机现收
              </button>
            </div>

            <div className="mt-4 p-3 bg-yellow-50 rounded-lg text-sm text-yellow-700 border border-yellow-200">
              🔔 Demo 演示 · 点击确认即模拟付款成功
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={submitting}>取消</Button>
            <Button
              className="flex-1 text-white hover:opacity-90"
              style={{ background: PURPLE }}
              onClick={handlePay}
              disabled={submitting}
            >
              {submitting ? '提交中…' : '确认付款'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
