import type { OrderItem, ReturnItem } from '@/lib/types'
import { orderIncTaxTotal } from '@/lib/order-items'

/** Return credit using the same quantity and tax rules shown in the driver trip card. */
export function calculateReturnAdjustment(items: OrderItem[], returns: ReturnItem[]) {
  const remainingByProduct = new Map<string, number>()
  for (const item of items) {
    remainingByProduct.set(item.productId, (remainingByProduct.get(item.productId) ?? 0) + Math.max(0, Number(item.quantity) || 0))
  }

  let exTax = 0
  let tax = 0
  for (const ret of returns) {
    if (ret.actionType === 'exchange' || ret.status === 'REJECTED') continue
    let qtyLeft = Math.max(0, Number(ret.quantity) || 0)
    const matchingItems = items.filter(item => item.productId === ret.productId)
    for (const item of matchingItems) {
      if (qtyLeft <= 0) break
      const remaining = remainingByProduct.get(item.productId) ?? 0
      const qty = Math.min(qtyLeft, remaining, Math.max(0, Number(item.quantity) || 0))
      if (qty <= 0) continue
      const unitPrice = Number.isFinite(Number(ret.unitPrice)) ? Number(ret.unitPrice) : Number(item.price) || 0
      const rate = Number(item.taxRate) || 0
      const taxFraction = rate > 1 ? rate / 100 : rate
      exTax += unitPrice * qty
      tax += unitPrice * qty * taxFraction
      qtyLeft -= qty
      remainingByProduct.set(item.productId, remaining - qty)
    }
  }

  exTax = Math.round(exTax * 100) / 100
  tax = Math.round(tax * 100) / 100
  return { exTax, tax, incTax: Math.round((exTax + tax) * 100) / 100 }
}

export function tripRestaurantAmountDue(items: OrderItem[], returns: ReturnItem[]): number {
  const grossDue = orderIncTaxTotal(items)
  const returnCredit = calculateReturnAdjustment(items, returns).incTax
  return Math.max(0, Math.round((grossDue - returnCredit) * 100) / 100)
}

export function isSameMoneyAmount(actual: unknown, expected: number): boolean {
  const value = Number(actual)
  return actual !== null && actual !== undefined && Number.isFinite(value)
    && Math.round(value * 100) === Math.round(expected * 100)
}
