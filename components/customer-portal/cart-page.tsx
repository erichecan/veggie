'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { ArrowLeft, Check, Minus, Plus, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { apiPost } from '@/lib/api'
import { DatePicker } from '@/components/ui/date-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { eur } from '@/lib/format-money'
import { routing } from '@/i18n/routing'
import { CART_UPDATED_EVENT, loadCart, PORTAL_CATALOG_SCROLL_KEY, saveCart, type CartItem } from './cart-utils'

const PRIMARY = '#356b2f'
const lineKey = (item: CartItem) => `${item.productId}__${item.uomName ?? ''}`

function tomorrowDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function CustomerCartPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const router = useRouter()
  const [cart, setCart] = useState<CartItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ready, setReady] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingQuantity, setEditingQuantity] = useState('1')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'ONLINE'>('CASH')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const current = loadCart()
    // Read localStorage only after hydration to keep the server and first client render identical.
    setCart(current)
    setSelected(new Set(current.map(lineKey)))
    setDeliveryDate(tomorrowDate())
    setReady(true)
    const sync = () => {
      const latest = loadCart()
      setCart(latest)
      setSelected(previous => new Set(latest.map(lineKey).filter(key => previous.has(key))))
    }
    window.addEventListener(CART_UPDATED_EVENT, sync)
    return () => window.removeEventListener(CART_UPDATED_EVENT, sync)
  }, [])

  const selectedItems = useMemo(() => cart.filter(item => selected.has(lineKey(item))), [cart, selected])
  const selectedSubtotal = selectedItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const selectedTax = selectedItems.reduce((sum, item) => sum + item.price * item.quantity * ((item.taxRate ?? 0) / 100), 0)
  const selectedCount = selectedItems.reduce((sum, item) => sum + item.quantity, 0)
  const allSelected = cart.length > 0 && cart.every(item => selected.has(lineKey(item)))

  function updateCart(next: CartItem[]) {
    setCart(next)
    saveCart(next)
    const keys = new Set(next.map(lineKey))
    setSelected(previous => new Set([...previous].filter(key => keys.has(key))))
  }

  function setQuantity(item: CartItem, quantity: number) {
    if (quantity <= 0) {
      updateCart(cart.filter(candidate => lineKey(candidate) !== lineKey(item)))
      setEditingKey(null)
      return
    }
    updateCart(cart.map(candidate => lineKey(candidate) === lineKey(item) ? { ...candidate, quantity } : candidate))
  }

  function backToCatalog() {
    if (sessionStorage.getItem(PORTAL_CATALOG_SCROLL_KEY) == null) sessionStorage.setItem(PORTAL_CATALOG_SCROLL_KEY, '0')
    router.push(`${prefix}/customer-portal`)
  }

  async function placeOrder() {
    if (selectedItems.length === 0) {
      toast.error(isEn ? 'Select at least one item to continue.' : '请至少选择一件商品再结算。')
      return
    }
    if (!deliveryDate) {
      toast.error(isEn ? 'Choose a delivery date.' : '请选择配送日期。')
      return
    }
    setSubmitting(true)
    try {
      const result = await apiPost<{ id: string; code: string }>('/api/customer-portal/orders', {
        items: selectedItems.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
          ...(item.uomId ? { uomId: item.uomId } : {}),
          ...(item.uomName ? { uomName: item.uomName } : {}),
        })),
        deliveryDate,
        paymentMethod,
        ...(note.trim() ? { internalNote: note.trim().slice(0, 30) } : {}),
      })
      const orderedKeys = new Set(selectedItems.map(lineKey))
      updateCart(cart.filter(item => !orderedKeys.has(lineKey(item))))
      toast.success(isEn ? `Order placed · ${result.code}` : `下单成功 · ${result.code}`)
      router.push(`${prefix}/customer-portal/orders/${result.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Could not place this order.' : '提交订单失败，请重试。'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!ready) {
    return <CartLoading isEn={isEn} />
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 pb-36 sm:pb-8" data-testid="customer-cart-page">
      <div className="flex items-center gap-3">
        <button type="button" onClick={backToCatalog} aria-label={isEn ? 'Back to products' : '返回商品'} className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--portal-border)] bg-white text-gray-700">
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-gray-900">{isEn ? 'Shopping cart' : '购物车'} <span className="text-base font-medium text-gray-500">({cart.reduce((sum, item) => sum + item.quantity, 0)})</span></h1>
          <p className="text-xs text-gray-500">{isEn ? 'Review items and quantities before checkout.' : '确认商品和数量后提交订单。'}</p>
        </div>
      </div>

      {cart.length === 0 ? (
        <div className="rounded-2xl border border-[var(--portal-border)] bg-white px-5 py-16 text-center">
          <ShoppingBag className="mx-auto size-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">{isEn ? 'Your cart is empty.' : '购物车还是空的。'}</p>
          <button onClick={backToCatalog} className="mt-4 rounded-xl px-4 py-2 text-sm font-semibold text-white" style={{ background: PRIMARY }}>{isEn ? 'Browse products' : '去选购商品'}</button>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-[var(--portal-border)] bg-white">
            <div className="flex min-h-12 items-center gap-3 border-b border-gray-100 px-4">
              <SelectionMark checked={allSelected} onClick={() => setSelected(allSelected ? new Set() : new Set(cart.map(lineKey)))} />
              <button type="button" onClick={() => setSelected(allSelected ? new Set() : new Set(cart.map(lineKey)))} className="text-sm font-medium text-gray-700">
                {allSelected ? (isEn ? 'Deselect all' : '取消全选') : (isEn ? 'Select all' : '全选')}
              </button>
              <span className="ml-auto text-xs text-gray-500">{isEn ? `${selectedItems.length} selected` : `已选 ${selectedItems.length} 项`}</span>
            </div>

            {cart.map(item => {
              const key = lineKey(item)
              const checked = selected.has(key)
              return (
                <article key={key} className={`flex gap-3 border-b border-gray-100 p-3 last:border-b-0 sm:gap-4 sm:p-4 ${checked ? '' : 'opacity-60'}`}>
                  <SelectionMark checked={checked} onClick={() => setSelected(previous => {
                    const next = new Set(previous)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })} />
                  <div className="h-[5.25rem] w-[5.25rem] shrink-0 overflow-hidden rounded-xl bg-gray-100 sm:h-24 sm:w-24">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-3xl text-gray-300">🥬</div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <h2 className="min-w-0 flex-1 font-semibold leading-5 text-gray-900">{item.name}</h2>
                      <Popover open={editingKey === key} onOpenChange={open => {
                        if (open) {
                          setEditingKey(key)
                          setEditingQuantity(String(item.quantity))
                        } else if (editingKey === key) {
                          setEditingKey(null)
                        }
                      }}>
                        <PopoverTrigger type="button" className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-sm font-semibold text-gray-800 hover:border-green-700" aria-label={isEn ? `Change quantity for ${item.name}` : `修改${item.name}数量`}>
                          ×{item.quantity}
                        </PopoverTrigger>
                        <PopoverContent side="top" align="end" className="w-auto min-w-60 p-2.5">
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => setEditingQuantity(value => String(Math.max(0, Number(value || 0) - 1)))} aria-label={isEn ? 'Decrease quantity' : '减少数量'} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
                              <Minus className="size-4" />
                            </button>
                            <input type="number" min="0" step="0.5" value={editingQuantity} onChange={event => setEditingQuantity(event.target.value)} onKeyDown={event => {
                              if (event.key === 'Enter' && Number.isFinite(Number(editingQuantity)) && Number(editingQuantity) >= 0) {
                                setQuantity(item, Number(editingQuantity))
                                setEditingKey(null)
                              }
                            }} className="h-9 w-20 rounded-lg border border-gray-200 text-center text-sm font-semibold" aria-label={isEn ? 'Quantity' : '数量'} />
                            <button type="button" onClick={() => setEditingQuantity(value => String(Number(value || 0) + 1))} aria-label={isEn ? 'Increase quantity' : '增加数量'} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
                              <Plus className="size-4" />
                            </button>
                            <button type="button" disabled={!Number.isFinite(Number(editingQuantity)) || Number(editingQuantity) < 0} onClick={() => {
                              setQuantity(item, Number(editingQuantity))
                              setEditingKey(null)
                            }} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: PRIMARY }}>
                              {isEn ? 'Apply' : '确定'}
                            </button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <p className="mt-1 text-sm text-gray-500">{[item.spec, item.uomName].filter(Boolean).join(' · ') || (isEn ? 'Standard unit' : '标准单位')}</p>
                    {item.promoLabel && <span className="mt-1 inline-flex rounded border border-orange-200 px-1.5 py-0.5 text-[11px] font-medium text-orange-700">{item.promoLabel}</span>}
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-bold" style={{ color: PRIMARY }}>{eur(item.price)}</span>
                      {item.originalPrice != null && item.originalPrice > item.price && <span className="text-xs text-gray-400 line-through">{eur(item.originalPrice)}</span>}
                      <span className="ml-auto text-sm font-semibold text-gray-800">{eur(item.price * item.quantity)}</span>
                    </div>
                    <button type="button" onClick={() => updateCart(cart.filter(candidate => lineKey(candidate) !== key))} className="mt-1 text-xs text-red-600">{isEn ? 'Remove' : '移除'}</button>
                  </div>
                </article>
              )
            })}
          </section>

          <section className="grid gap-3 rounded-2xl border border-[var(--portal-border)] bg-white p-4 sm:grid-cols-2">
            <label className="text-xs text-gray-500">{isEn ? 'Delivery date' : '配送日期'}
              <DatePicker value={deliveryDate} min={tomorrowDate()} onChange={setDeliveryDate} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm text-gray-800" />
            </label>
            <label className="text-xs text-gray-500">{isEn ? 'Payment method' : '付款方式'}
              <select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value as 'CASH' | 'ONLINE')} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800">
                <option value="CASH">{isEn ? 'Cash on delivery' : '司机现收'}</option>
                <option value="ONLINE">{isEn ? 'Bank transfer' : '银行转账'}</option>
              </select>
            </label>
            <label className="text-xs text-gray-500 sm:col-span-2">{isEn ? 'Order note (up to 30 characters)' : '订单备注（最多30字）'}
              <input value={note} onChange={event => setNote(event.target.value.slice(0, 30))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800" placeholder={isEn ? 'Optional' : '选填'} />
            </label>
          </section>

          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-5px_18px_rgba(0,0,0,0.06)] backdrop-blur sm:static sm:rounded-2xl sm:border sm:shadow-none">
            <div className="mx-auto flex max-w-4xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-gray-500">{isEn ? `${selectedCount} selected` : `已选 ${selectedCount} 件`}</div>
                <div className="font-bold text-gray-900">{isEn ? 'Total' : '合计'} <span style={{ color: PRIMARY }}>{eur(selectedSubtotal + selectedTax)}</span></div>
                {selectedTax > 0 && <div className="text-[11px] text-gray-400">{isEn ? 'Including VAT' : `含税 ${eur(selectedTax)}`}</div>}
              </div>
              <button type="button" onClick={() => void placeOrder()} disabled={submitting || selectedItems.length === 0} className="inline-flex min-h-12 min-w-36 items-center justify-center gap-2 rounded-xl px-5 font-semibold text-white disabled:opacity-50" style={{ background: PRIMARY }}>
                <Check className="size-4" />{submitting ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? `Checkout (${selectedCount})` : `结算 (${selectedCount})`)}
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  )
}

function SelectionMark({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={checked} onClick={onClick} className={`mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-[#356b2f] bg-[#356b2f] text-white' : 'border-gray-300 bg-white text-transparent'}`}><Check className="size-4" /></button>
}

function CartLoading({ isEn }: { isEn: boolean }) {
  return <div className="mx-auto max-w-4xl space-y-4" aria-live="polite"><h1 className="text-xl font-bold text-gray-900">{isEn ? 'Shopping cart' : '购物车'}</h1><p className="text-sm text-gray-500">{isEn ? 'Refreshing your saved cart…' : '正在读取最新购物车…'}</p>{[0, 1, 2].map(i => <div key={i} className="h-28 animate-pulse rounded-2xl border border-[var(--portal-border)] bg-white" />)}</div>
}
