'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { eur } from '@/lib/format-money'
import { loadCart, saveCart, toPercent, mergeCartItems, type CartItem } from './cart-utils'
import type { Product, FrequentCard } from './product-types'

const PAGE_SIZE = 24
const SEARCH_DEBOUNCE_MS = 350

/** 原型演示：配送日期运力提示——真实规则(容量数据从哪来、阈值多少)还没定，这里只做占位展示 */
function mockCapacityWarning(dateStr: string, isEn: boolean): string | null {
  if (!dateStr) return null
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  if (day === 1 || day === 5) {
    return isEn
      ? '[Prototype] This date already has heavy delivery demand — consider an earlier date'
      : '【原型演示】该日期配送需求较多，建议提前一天下单'
  }
  return null
}

/** 商品目录首页的全部状态与操作——从页面组件里拆出来，page.tsx 只管拼 JSX */
export function useCustomerPortal(isEn: boolean, orderDetailPathPrefix: string) {
  const [products, setProducts] = useState<Product[]>([])
  const [gridLoading, setGridLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [paymentTerm, setPaymentTerm] = useState<string | null>(null)
  const [frequent, setFrequent] = useState<FrequentCard[]>([])
  // 初始值必须是 []，不能直接拿 loadCart() 做懒初始化——SSR 阶段没有 localStorage，
  // 服务端渲染出的是空购物车；如果客户端首次渲染就用 localStorage 里的旧购物车对不上，
  // React 会报 hydration mismatch 并整棵树重新渲染。改成挂载后在 effect 里补水。
  const [cart, setCart] = useState<CartItem[]>([])
  useEffect(() => { setCart(loadCart()) }, [])
  const [submitting, setSubmitting] = useState(false)
  const [showCart, setShowCart] = useState(false)
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'ONLINE'>('CASH')
  const [note, setNote] = useState('')

  const router = useRouter()

  // 搜索防抖：每敲一个字就打服务端不合适，商品名比订单号长得多
  useEffect(() => {
    const t = setTimeout(() => { setActiveSearch(searchInput.trim()); setPage(1) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    // 翻页很快时，先发的请求可能后回来——没有这层守卫，第2页的响应能覆盖已经跳到第3页的结果
    let cancelled = false
    setGridLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (activeSearch) params.set('search', activeSearch)
    apiGet<{ products: Product[]; paymentTerm?: string; totalPages: number }>(`/api/customer-portal/products?${params}`)
      .then((d) => {
        if (cancelled) return
        setProducts(d.products || [])
        setPaymentTerm(d.paymentTerm ?? null)
        setTotalPages(d.totalPages || 1)
      })
      .catch(() => { if (!cancelled) toast.error(isEn ? 'Failed to load products' : '加载商品失败') })
      .finally(() => { if (!cancelled) setGridLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, activeSearch])

  useEffect(() => {
    apiGet<FrequentCard[]>('/api/customer-portal/frequently-ordered')
      .then(setFrequent)
      .catch(() => {}) // 常购清单是锦上添花，加载失败不影响正常下单
  }, [])

  const updateCart = useCallback((newCart: CartItem[]) => {
    setCart(newCart)
    saveCart(newCart)
  }, [])

  const addToCart = useCallback((p: Product, qty = 1) => {
    setCart((prev) => {
      const next = mergeCartItems(prev, [{
        productId: p.id, name: p.name, spec: p.spec, uomName: p.uomName,
        price: p.customerPrice ?? 0, quantity: qty, taxRate: toPercent(p.customerTaxRate),
      }])
      saveCart(next)
      return next
    })
    toast.success(isEn ? `Added ${p.name}` : `已添加 ${p.name}`)
  }, [isEn])

  const handleBulkAdd = useCallback((items: CartItem[]) => {
    setCart((prev) => {
      const next = mergeCartItems(prev, items)
      saveCart(next)
      return next
    })
    setShowCart(true)
  }, [])

  function setQty(productId: string, qty: number) {
    if (qty <= 0) {
      updateCart(cart.filter((c) => c.productId !== productId))
    } else {
      updateCart(cart.map((c) => (c.productId === productId ? { ...c, quantity: qty } : c)))
    }
  }

  function removeFromCart(productId: string) {
    updateCart(cart.filter((c) => c.productId !== productId))
  }

  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  const cartTax = cart.reduce((s, c) => s + c.price * c.quantity * ((c.taxRate ?? 0) / 100), 0)
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)

  async function placeOrder() {
    if (cart.length === 0) { toast.error(isEn ? 'Your cart is empty' : '购物车为空'); return }
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity, price: c.price })),
        paymentMethod,
      }
      if (deliveryDate) body.deliveryDate = deliveryDate
      if (note.trim()) body.internalNote = note.trim()

      const res = await apiPost<{ id: string; code: string; totalAmount: number }>('/api/customer-portal/orders', body)
      toast.success(isEn
        ? `Order placed! Order #: ${res.code}, total due: ${eur(cartTotal + cartTax)}`
        : `下单成功！订单号: ${res.code}，应付: ${eur(cartTotal + cartTax)}`)
      updateCart([])
      setShowCart(false)
      setNote('')
      router.push(`${orderDetailPathPrefix}/${res.id}`)
    } catch (e: unknown) {
      toast.error((e as Error).message || (isEn ? 'Failed to place order' : '下单失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const minDate = tomorrow.toISOString().slice(0, 10)
  const capacityWarning = mockCapacityWarning(deliveryDate, isEn)

  return {
    products, gridLoading, page, setPage, totalPages,
    searchInput, setSearchInput, activeSearch, paymentTerm,
    frequent, cart, submitting, showCart, setShowCart,
    deliveryDate, setDeliveryDate, minDate, capacityWarning,
    paymentMethod, setPaymentMethod, note, setNote,
    addToCart, handleBulkAdd, setQty, removeFromCart, placeOrder,
    cartTotal, cartTax, cartCount,
  }
}
