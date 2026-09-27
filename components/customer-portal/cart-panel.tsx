'use client'
import { eur } from '@/lib/format-money'
import { DatePicker } from '@/components/ui/date-picker'
import type { CartItem } from './cart-utils'

const PURPLE = '#875A7B'

export function CartPanel({
  cart, cartTotal, cartTax, setQty, removeFromCart,
  deliveryDate, setDeliveryDate, minDate, capacityWarning,
  paymentMethod, setPaymentMethod, note, setNote,
  submitting, placeOrder, isEn,
}: {
  cart: CartItem[]
  cartTotal: number
  cartTax: number
  setQty: (productId: string, qty: number) => void
  removeFromCart: (productId: string) => void
  deliveryDate: string
  setDeliveryDate: (v: string) => void
  minDate: string
  capacityWarning: string | null
  paymentMethod: 'CASH' | 'ONLINE'
  setPaymentMethod: (v: 'CASH' | 'ONLINE') => void
  note: string
  setNote: (v: string) => void
  submitting: boolean
  placeOrder: () => void
  isEn: boolean
}) {
  return (
    <div className="bg-white rounded-xl shadow-lg border p-5 space-y-4">
      <h2 className="font-bold text-lg" style={{ color: PURPLE }}>🛒 {isEn ? 'Cart' : '购物车'}</h2>
      {cart.length === 0 ? (
        <p className="text-gray-400 text-sm py-4 text-center">{isEn ? 'Your cart is empty. Add some products first.' : '购物车为空，请先添加商品'}</p>
      ) : (
        <>
          <div className="divide-y">
            {cart.map((c) => (
              <div key={c.productId} className="flex items-center justify-between py-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{c.name}</p>
                  <p className="text-xs text-gray-400">
                    {[c.spec, c.uomName].filter(Boolean).map((v) => `${v} · `).join('')}{eur(c.price)}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <button onClick={() => setQty(c.productId, c.quantity - 1)}
                    className="w-7 h-7 rounded border text-sm flex items-center justify-center hover:bg-gray-100">−</button>
                  <input type="number" value={c.quantity} min={0} step={0.5}
                    onChange={(e) => setQty(c.productId, parseFloat(e.target.value) || 0)}
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
              <span>{isEn ? 'Subtotal (excl. tax)' : '合计（不含税）'}</span>
              <span style={{ color: PURPLE }}>{eur(cartTotal)}</span>
            </div>
            {cartTax > 0 && (
              <div className="flex items-center justify-between text-xs text-gray-500 pb-2">
                <span>{isEn ? 'Tax' : '税额'}</span>
                <span>{eur(cartTax)}</span>
              </div>
            )}
            {cartTax > 0 && (
              <div className="flex items-center justify-between text-sm font-bold pb-3">
                <span>{isEn ? 'Total (incl. tax)' : '含税应付'}</span>
                <span style={{ color: PURPLE }}>{eur(cartTotal + cartTax)}</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">{isEn ? 'Delivery Date' : '配送日期'}</label>
                <DatePicker value={deliveryDate} min={minDate}
                  onChange={setDeliveryDate}
                  className="w-full border rounded px-3 py-2 text-sm" />
                {capacityWarning && (
                  <p className="text-xs text-amber-600 mt-1 border border-dashed border-amber-300 bg-amber-50 rounded px-2 py-1">
                    {capacityWarning}
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">{isEn ? 'Payment Method' : '付款方式'}</label>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as 'CASH' | 'ONLINE')}
                  className="w-full border rounded px-3 py-2 text-sm">
                  <option value="CASH">{isEn ? 'Cash' : '现金'}</option>
                  <option value="ONLINE">{isEn ? 'Online Payment' : '在线支付'}</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">{isEn ? 'Notes (max 30 characters)' : '备注（最多30字）'}</label>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value.slice(0, 30))}
                placeholder={isEn ? 'Special requests (optional)' : '如有特殊要求请备注'}
                className="w-full border rounded px-3 py-2 text-sm" />
            </div>
            <button onClick={placeOrder} disabled={submitting || cart.length === 0}
              className="w-full py-3 rounded-lg text-white font-medium disabled:opacity-50 transition-colors"
              style={{ background: PURPLE }}>
              {submitting ? (isEn ? 'Submitting...' : '提交中...') : (isEn ? `Place Order (${eur(cartTotal + cartTax)})` : `确认下单 (${eur(cartTotal + cartTax)})`)}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
