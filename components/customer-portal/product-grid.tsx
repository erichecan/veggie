'use client'
import { eur } from '@/lib/format-money'
import { Pagination } from '@/components/ui/pagination'
import type { CartItem } from './cart-utils'
import type { Product } from './product-types'

const PURPLE = '#875A7B'

export function ProductGrid({
  products, cart, addToCart, setQty,
  page, totalPages, setPage, activeSearch, isEn,
}: {
  products: Product[]
  cart: CartItem[]
  addToCart: (p: Product) => void
  setQty: (productId: string, qty: number) => void
  page: number
  totalPages: number
  setPage: (p: number) => void
  activeSearch: string
  isEn: boolean
}) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {products.map((p, idx) => {
          const inCart = cart.find((c) => c.productId === p.id)
          // 原型演示：起订量提示——真实规则(哪些商品有起订量、门槛多少)还没定，只在第一页第一张卡片上演示样式
          const showMoqDemo = idx === 0 && page === 1 && !activeSearch
          return (
            <div key={p.id} className="bg-white rounded-xl border p-4 flex flex-col justify-between hover:shadow-md transition-shadow">
              <div>
                {(p.outOfStock || p.promoLabel || p.isNew) && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {p.outOfStock && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">
                        {isEn ? 'Out of stock' : '暂时缺货'}
                      </span>
                    )}
                    {p.promoLabel && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded text-white bg-rose-600">
                        {p.promoLabel}
                      </span>
                    )}
                    {p.isNew && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                        {isEn ? 'New' : '新品'}
                      </span>
                    )}
                  </div>
                )}
                <h3 className="font-medium text-sm">{p.name}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {p.spec && <span>{p.spec} · </span>}
                  {p.uomName || (isEn ? 'unit' : '个')}
                  {p.internalRef && <span> · {p.internalRef}</span>}
                </p>
                {showMoqDemo && (
                  <p className="text-xs text-amber-600 mt-1 border border-dashed border-amber-300 bg-amber-50 rounded px-2 py-0.5 inline-block">
                    {isEn ? '[Prototype] Min order: 5 units' : '【原型演示】最小起订 5 件'}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="flex items-baseline gap-1.5">
                  {p.promoLabel && p.originalPrice != null && p.customerPrice != null && p.originalPrice !== p.customerPrice && (
                    <span className="text-xs text-gray-400 line-through">{eur(p.originalPrice)}</span>
                  )}
                  <span className="text-lg font-bold" style={{ color: PURPLE }}>
                    {p.customerPrice != null ? eur(p.customerPrice) : (isEn ? 'Price on request' : '询价')}
                  </span>
                </span>
                {p.customerPrice != null ? (
                  inCart ? (
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setQty(p.id, inCart.quantity - 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">−</button>
                      <span className="text-sm font-medium w-8 text-center">{inCart.quantity}</span>
                      <button onClick={() => setQty(p.id, inCart.quantity + 1)}
                        className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">+</button>
                    </div>
                  ) : (
                    <button onClick={() => addToCart(p)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
                      style={{ background: PURPLE }}>
                      {isEn ? 'Add to Cart' : '加入购物车'}
                    </button>
                  )
                ) : (
                  <span className="text-xs text-gray-400">{isEn ? 'No price available' : '暂无报价'}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {products.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          {activeSearch
            ? (isEn ? `No products found for "${activeSearch}"` : `没有找到 "${activeSearch}" 相关商品`)
            : (isEn ? 'No products available' : '暂无商品')}
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </>
  )
}
