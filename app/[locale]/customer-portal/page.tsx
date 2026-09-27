'use client'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { RecentOrdersPanel } from '@/components/customer-portal/recent-orders-panel'
import { FavoritesPanel } from '@/components/customer-portal/favorites-panel'
import { FrequentTab } from '@/components/customer-portal/frequent-tab'
import { CartPanel } from '@/components/customer-portal/cart-panel'
import { ProductGrid } from '@/components/customer-portal/product-grid'
import { BannerCarousel } from '@/components/customer-portal/banner-carousel'
import { CategorySidebar } from '@/components/customer-portal/category-sidebar'
import { useCustomerPortal } from '@/components/customer-portal/use-customer-portal'
import { useState } from 'react'

const PURPLE = '#875A7B'
const PAYMENT_LABELS_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABELS_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }

type Tab = 'recent' | 'frequent' | 'favorites'

export default function CustomerProductsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH
  const TAB_LABELS: Record<Tab, string> = {
    recent: isEn ? 'Recent Orders' : '最近订单',
    frequent: isEn ? 'Frequently Ordered' : '常购单品',
    favorites: isEn ? 'My Lists' : '我的收藏',
  }

  const [tab, setTab] = useState<Tab>('recent')
  const p = useCustomerPortal(isEn, `${prefix}/customer-portal/orders`)

  return (
    <div className="space-y-4">
      <BannerCarousel banners={p.banners} onBannerClick={p.handleBannerClick} />

      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <input type="text" value={p.searchInput} onChange={(e) => p.setSearchInput(e.target.value)}
            placeholder={isEn ? 'Search products...' : '搜索商品名称...'}
            className="w-full border rounded-lg px-4 py-2.5 text-sm pr-8 focus:outline-none focus:ring-2"
            style={{ borderColor: '#ddd', focusRingColor: PURPLE } as React.CSSProperties}
          />
          {p.searchInput && (
            <button onClick={() => p.setSearchInput('')} className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600">✕</button>
          )}
        </div>
        <button onClick={() => p.setShowCart(!p.showCart)}
          className="relative px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
          style={{ background: PURPLE }}>
          🛒 {isEn ? 'Cart' : '购物车'}
          {p.cartCount > 0 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {p.cartCount}
            </span>
          )}
        </button>
      </div>

      {p.paymentTerm && (
        <p className="text-xs text-gray-500">
          {isEn ? 'Payment Term: ' : '结算方式：'}<span className="font-medium" style={{ color: PURPLE }}>{PAYMENT_LABELS[p.paymentTerm] ?? p.paymentTerm}</span>
        </p>
      )}

      {/* 快捷下单区：最近订单(整单再来一单) / 常购单品(单品复购) / 我的收藏(自存清单模板) */}
      <div className="space-y-3">
        <div className="flex gap-2">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors border"
              style={tab === t ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { borderColor: '#ddd', color: '#666' }}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        {tab === 'recent' && <RecentOrdersPanel onReorder={p.handleBulkAdd} isEn={isEn} />}
        {tab === 'frequent' && <FrequentTab frequent={p.frequent} onReorder={p.addToCart} isEn={isEn} />}
        {tab === 'favorites' && <FavoritesPanel cart={p.cart} onApply={p.handleBulkAdd} isEn={isEn} />}
      </div>

      {p.showCart && (
        <CartPanel
          cart={p.cart} cartTotal={p.cartTotal} cartTax={p.cartTax} setQty={p.setQty} removeFromCart={p.removeFromCart}
          deliveryDate={p.deliveryDate} setDeliveryDate={p.setDeliveryDate} minDate={p.minDate} capacityWarning={p.capacityWarning}
          paymentMethod={p.paymentMethod} setPaymentMethod={p.setPaymentMethod} note={p.note} setNote={p.setNote}
          submitting={p.submitting} placeOrder={p.placeOrder} isEn={isEn}
        />
      )}

      <div className="flex gap-4 items-start">
        <CategorySidebar categories={p.categories} activeCategoryId={p.categoryId} onSelect={p.selectCategory} isEn={isEn} />
        <div className="flex-1 min-w-0">
          {p.gridLoading ? (
            <div className="text-center py-20 text-gray-400">{isEn ? 'Loading products...' : '加载商品中...'}</div>
          ) : (
            <ProductGrid
              products={p.products} cart={p.cart} addToCart={p.addToCart} setQty={p.setQty}
              page={p.page} totalPages={p.totalPages} setPage={p.setPage} activeSearch={p.activeSearch} isEn={isEn}
            />
          )}
        </div>
      </div>
    </div>
  )
}
