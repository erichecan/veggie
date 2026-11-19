'use client'

import { useState } from 'react'
import { ArrowRight, Minus, Plus, ShoppingCart } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { eur } from '@/lib/format-money'
import type { CartItem } from './cart-utils'

const PRIMARY = '#356b2f'

export function CartPreviewDrawer({
  open, onOpenChange, cart, cartTotal, cartTax, setQty, removeFromCart, isEn, onViewCart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cart: CartItem[]
  cartTotal: number
  cartTax: number
  setQty: (productId: string, quantity: number, uomName?: string | null) => void
  removeFromCart: (productId: string, uomName?: string | null) => void
  isEn: boolean
  onViewCart: () => void
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const count = cart.reduce((sum, item) => sum + item.quantity, 0)
  const total = cartTotal + cartTax

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[86dvh] gap-0 overflow-hidden rounded-t-3xl border-0 p-0 sm:mx-auto sm:max-w-2xl">
        <SheetHeader className="border-b border-gray-100 px-5 py-4 pr-14 text-left">
          <SheetTitle className="text-xl font-bold text-gray-900">
            {isEn ? 'Cart' : '购物车'} <span className="text-base font-medium text-gray-500">({count})</span>
          </SheetTitle>
          <SheetDescription>{isEn ? 'Added items are saved in your cart.' : '已添加的商品已保存到购物车。'}</SheetDescription>
        </SheetHeader>
        <div className="max-h-[calc(86dvh-190px)] overflow-y-auto px-4 py-2 sm:px-5">
          {cart.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">{isEn ? 'Your cart is empty.' : '购物车为空。'}</p>
          ) : cart.map(item => {
            const key = `${item.productId}__${item.uomName ?? ''}`
            const quantity = item.quantity
            return (
              <article key={key} className="flex gap-3 border-b border-gray-100 py-3 last:border-b-0">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                  {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-2xl text-gray-300">🥬</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <h3 className="min-w-0 flex-1 font-semibold leading-5 text-gray-900">{item.name}</h3>
                    <span className="shrink-0 rounded-lg bg-gray-100 px-2.5 py-1 text-sm font-semibold text-gray-800">×{quantity}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">{[item.spec, item.uomName].filter(Boolean).join(' · ') || (isEn ? 'Standard unit' : '标准单位')}</p>
                  {item.promoLabel && <span className="mt-1 inline-flex rounded border border-orange-200 px-1.5 py-0.5 text-[11px] font-medium text-orange-700">{item.promoLabel}</span>}
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="font-bold" style={{ color: PRIMARY }}>{eur(item.price)}</span>
                    {item.originalPrice != null && item.originalPrice > item.price && <span className="text-xs text-gray-400 line-through">{eur(item.originalPrice)}</span>}
                    <span className="ml-auto text-sm font-semibold text-gray-800">{eur(item.price * quantity)}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button aria-label={isEn ? `Decrease ${item.name}` : `减少${item.name}数量`} onClick={() => setQty(item.productId, quantity - 1, item.uomName)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-700"><Minus className="size-4" /></button>
                    <input aria-label={isEn ? `Quantity for ${item.name}` : `${item.name}数量`} type="number" min="0.5" step="0.5" value={quantities[key] ?? String(quantity)} onChange={event => setQuantities(current => ({ ...current, [key]: event.target.value }))} onBlur={() => { const next = Number(quantities[key]); if (Number.isFinite(next) && next > 0) setQty(item.productId, next, item.uomName); setQuantities(current => { const copy = { ...current }; delete copy[key]; return copy }) }} className="h-8 w-16 rounded-lg border border-gray-200 text-center text-sm" />
                    <button aria-label={isEn ? `Increase ${item.name}` : `增加${item.name}数量`} onClick={() => setQty(item.productId, quantity + 1, item.uomName)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-700"><Plus className="size-4" /></button>
                    <button onClick={() => removeFromCart(item.productId, item.uomName)} className="ml-auto px-2 py-1 text-xs text-red-600">{isEn ? 'Remove' : '移除'}</button>
                  </div>
                </div>
              </article>
            )
          })}
          <button type="button" onClick={onViewCart} className="flex w-full items-center justify-center gap-2 py-4 font-semibold text-gray-500 hover:text-gray-800">
            {isEn ? 'View all items in cart' : '查看购物车全部商品'} <ArrowRight className="size-4" />
          </button>
        </div>
        <div className="border-t border-gray-100 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-gray-500">{isEn ? 'Estimated total' : '预计合计'}</span>
            <span className="text-lg font-bold" style={{ color: PRIMARY }}>{eur(total)}</span>
          </div>
          <button type="button" onClick={onViewCart} disabled={cart.length === 0} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 font-semibold text-white disabled:opacity-50" style={{ background: PRIMARY }}>
            <ShoppingCart className="size-4" />{isEn ? 'Go to cart' : '去购物车结算'}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
