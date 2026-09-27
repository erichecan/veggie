'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { eur } from '@/lib/format-money'
import { loadCart, saveCart, toPercent, mergeCartItems, type CartItem } from './cart-utils'
import type { Product, FrequentCard } from './product-types'

export interface PortalCategory {
  id: string
  name: string
  nameZh: string | null
  count: number
}

export interface PortalBanner {
  id: string
  title: string
  imageUrl: string
  linkUrl: string | null
  productId: string | null
}

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
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [categories, setCategories] = useState<PortalCategory[]>([])
  const [banners, setBanners] = useState<PortalBanner[]>([])
  // banner 点"跳转到商品"时精确定位到这一个商品 id（不走名字搜索，见 handleBannerClick 注释）
  const [jumpProductId, setJumpProductId] = useState<string | null>(null)
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
    const t = setTimeout(() => {
      const trimmed = searchInput.trim()
      setActiveSearch(trimmed)
      // 只在用户真的敲了字才清掉 banner 跳转的定位——handleBannerClick 会把搜索框重置成
      // 空字符串来清视觉残留，那次重置不该反过来把它刚设的 jumpProductId 顶掉
      if (trimmed) setJumpProductId(null)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    // 翻页很快时，先发的请求可能后回来——没有这层守卫，第2页的响应能覆盖已经跳到第3页的结果
    let cancelled = false
    setGridLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (jumpProductId) {
      // 精确定位单个商品时不叠加搜索/分类，避免"同时命中 id + 其他条件"的组合怪状态
      params.set('productId', jumpProductId)
    } else {
      if (activeSearch) params.set('search', activeSearch)
      if (categoryId) params.set('categoryId', categoryId)
    }
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
  }, [page, activeSearch, categoryId, jumpProductId])

  useEffect(() => {
    apiGet<FrequentCard[]>('/api/customer-portal/frequently-ordered')
      .then(setFrequent)
      .catch(() => {}) // 常购清单是锦上添花，加载失败不影响正常下单
  }, [])

  useEffect(() => {
    apiGet<PortalCategory[]>('/api/customer-portal/categories').then(setCategories).catch(() => {})
    apiGet<PortalBanner[]>('/api/customer-portal/banners').then(setBanners).catch(() => {})
  }, [])

  function selectCategory(id: string | null) {
    setCategoryId(id)
    setJumpProductId(null)
    setPage(1)
  }

  // 只有两个 locale（zh 默认无前缀 / en 前缀 /en），与 i18n/routing.ts 的配置保持一致
  const localePrefix = isEn ? '/en' : ''

  /**
   * 门户没有独立商品详情页（有意为之，减少下单步骤），banner 点商品时"跳转"
   * 就是把商品网格精确筛到这一个商品 id（20260927 code-review 发现：原来靠把商品名塞进
   * 搜索框实现，本库有过 60+ 组商品重名，同名商品会被一起搜出来，客户可能点进另一个商品；
   * 改成按 id 精确命中，与搜索/分类完全独立）。
   */
  async function handleBannerClick(banner: PortalBanner) {
    if (banner.linkUrl) {
      if (/^https?:\/\//.test(banner.linkUrl)) {
        window.open(banner.linkUrl, '_blank', 'noopener,noreferrer')
      } else {
        // 站内相对路径必须带上 locale 前缀，否则英文界面点了会静默跳回中文版
        router.push(`${localePrefix}${banner.linkUrl}`)
      }
      return
    }
    if (banner.productId) {
      try {
        // 用不受 status 限制的 ids= 先查一次，商品下架/删除时能给出明确提示，
        // 而不是让精确匹配的 productId 查询悄悄返回空网格（schema 注释里承诺过
        // "商品下架不应该连带炸掉一条已经在展示的 banner"，这里是那个承诺的另一半：
        // banner 本身还在，但点进去要说清楚"这个商品下架了"，不能什么都不说）
        const data = await apiGet<{ products: Product[] }>(`/api/customer-portal/products?ids=${banner.productId}`)
        const target = data.products[0]
        if (!target || target.status !== 'ACTIVE') {
          toast.error(isEn ? 'This product is no longer available' : '该商品已下架')
          return
        }
        setSearchInput('')
        setActiveSearch('')
        setCategoryId(null)
        setJumpProductId(banner.productId)
        setPage(1)
      } catch {
        toast.error(isEn ? 'Failed to open this product' : '打开商品失败')
      }
    }
  }

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
    categoryId, selectCategory, categories, banners, handleBannerClick,
    frequent, cart, submitting, showCart, setShowCart,
    deliveryDate, setDeliveryDate, minDate, capacityWarning,
    paymentMethod, setPaymentMethod, note, setNote,
    addToCart, handleBulkAdd, setQty, removeFromCart, placeOrder,
    cartTotal, cartTax, cartCount,
  }
}
