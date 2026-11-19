'use client'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { useRouter } from 'next/navigation'
import { RecentOrdersPanel } from '@/components/customer-portal/recent-orders-panel'
import { FavoritesPanel } from '@/components/customer-portal/favorites-panel'
import { FrequentTab } from '@/components/customer-portal/frequent-tab'
import { CartPreviewDrawer } from '@/components/customer-portal/cart-preview-drawer'
import { ProductGrid } from '@/components/customer-portal/product-grid'
import { BannerCarousel } from '@/components/customer-portal/banner-carousel'
import { CategorySidebar } from '@/components/customer-portal/category-sidebar'
import { useCustomerPortal } from '@/components/customer-portal/use-customer-portal'
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { PORTAL_CATALOG_SCROLL_KEY } from '@/components/customer-portal/cart-utils'

const PRIMARY = '#356b2f'
const PAYMENT_LABELS_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABELS_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }

type Tab = 'recent' | 'frequent' | 'favorites'

export default function CustomerProductsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH
  const router = useRouter()
  const TAB_LABELS: Record<Tab, string> = {
    recent: isEn ? 'Recent Orders' : '最近订单',
    frequent: isEn ? 'Frequently Ordered' : '常购单品',
    favorites: isEn ? 'My Lists' : '我的收藏',
  }

  const [tab, setTab] = useState<Tab>('recent')
  const [quickOrderOpen, setQuickOrderOpen] = useState(false)
  const p = useCustomerPortal(isEn, `${prefix}/customer-portal/orders`)

  useEffect(() => {
    const savedPosition = sessionStorage.getItem(PORTAL_CATALOG_SCROLL_KEY)
    if (savedPosition != null) {
      sessionStorage.removeItem(PORTAL_CATALOG_SCROLL_KEY)
      requestAnimationFrame(() => window.scrollTo({ top: Number(savedPosition) || 0, behavior: 'instant' }))
    }
  }, [])

  function viewCart() {
    sessionStorage.setItem(PORTAL_CATALOG_SCROLL_KEY, String(window.scrollY))
    p.setCartPreviewOpen(false)
    router.push(`${prefix}/customer-portal/cart`)
  }

  return (
    <div className="space-y-4">
      <BannerCarousel banners={p.banners} onBannerClick={p.handleBannerClick} />

      <div className="lg:flex lg:gap-4 lg:items-start">
        <CategorySidebar categories={p.categories} activeCategoryId={p.categoryId} onSelect={p.selectCategory} isEn={isEn} />
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1 relative">
              <input type="text" value={p.searchInput} onChange={(e) => p.setSearchInput(e.target.value)}
                placeholder={isEn ? 'Search products...' : '搜索商品名称...'}
                className="w-full border rounded-lg px-4 py-2.5 text-sm pr-8 focus:outline-none focus:ring-2 focus:border-green-700 focus:ring-green-700"
                style={{ borderColor: '#d7e1d4' }}
              />
              {p.searchInput && (
                <button onClick={() => p.setSearchInput('')} className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600">✕</button>
              )}
            </div>
          </div>

          {p.paymentTerm && (
            <p className="text-xs text-gray-500">
              {isEn ? 'Payment Term: ' : '结算方式：'}<span className="font-medium" style={{ color: PRIMARY }}>{PAYMENT_LABELS[p.paymentTerm] ?? p.paymentTerm}</span>
            </p>
          )}

          {/* 快捷复购默认收起，避免占据首屏商品区域 */}
          <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: 'var(--portal-border)' }}>
            <button type="button" onClick={() => setQuickOrderOpen((open) => !open)} aria-expanded={quickOrderOpen}
              className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-medium"
              style={{ color: '#3f513c' }}>
              <span>{isEn ? 'Quick reorder' : '快捷复购'} <span className="ml-1 text-xs font-normal text-gray-500">{isEn ? 'Recent orders · Frequently ordered · My lists' : '最近订单 · 常购单品 · 我的收藏'}</span></span>
              <ChevronDown aria-hidden="true" className={`size-4 shrink-0 transition-transform ${quickOrderOpen ? 'rotate-180' : ''}`} />
            </button>
            {quickOrderOpen && <div className="space-y-3 border-t p-3" style={{ borderColor: 'var(--portal-border)' }}>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
                  <button key={t} onClick={() => setTab(t)}
                    className="min-h-9 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
                    style={tab === t ? { background: PRIMARY, color: 'white', borderColor: PRIMARY } : { borderColor: '#d7e1d4', color: '#52604f' }}>
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>
              {tab === 'recent' && <RecentOrdersPanel onReorder={p.handleBulkAdd} isEn={isEn} />}
              {tab === 'frequent' && <FrequentTab frequent={p.frequent} onReorder={p.addToCart} isEn={isEn} />}
              {tab === 'favorites' && <FavoritesPanel cart={p.cart} onApply={p.handleBulkAdd} isEn={isEn} />}
            </div>}
          </div>

        <div className="min-w-0">
          {p.gridLoading ? (
            <div className="text-center py-20 text-gray-400">{isEn ? 'Loading products...' : '加载商品中...'}</div>
          ) : (
            <ProductGrid
              products={p.products} cart={p.cart} addToCart={p.addToCart} setQty={p.setQty}
              page={p.page} totalPages={p.totalPages} setPage={p.setPage} activeSearch={p.activeSearch} isEn={isEn}
              loadError={p.loadError}
            />
          )}
        </div>
        </div>
      </div>
      <CartPreviewDrawer
        open={p.cartPreviewOpen}
        onOpenChange={p.setCartPreviewOpen}
        cart={p.cart}
        cartTotal={p.cartTotal}
        cartTax={p.cartTax}
        setQty={p.setQty}
        removeFromCart={p.removeFromCart}
        isEn={isEn}
        onViewCart={viewCart}
      />
    </div>
  )
}
