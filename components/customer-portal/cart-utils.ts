export interface CartItem {
  productId: string
  name: string
  spec: string | null
  uomName: string | null
  price: number
  quantity: number
  /** 百分数（13.5 而非 0.135），购物车按这个口径算税 */
  taxRate?: number
}

const CART_KEY = 'veggie_cart'

export function loadCart(): CartItem[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveCart(items: CartItem[]) {
  localStorage.setItem(CART_KEY, JSON.stringify(items))
}

/**
 * 税率归一成百分数。商品档案存的是小数（0.1350），前端一律按百分数算税，
 * 与服务端 lib/server-pricing.ts 的 normalizeTaxRate 同一套规则：
 * IE 的 VAT 档位在 (0,1) 区间无合法值，故「小于 1 即视为小数」无歧义。
 */
export function toPercent(v: number | null | undefined): number | undefined {
  if (v == null || !Number.isFinite(v)) return undefined
  return v > 0 && v < 1 ? v * 100 : v
}

/**
 * 把一批新商品合并进现有购物车——已存在的加数量，新的追加到末尾。
 *
 * 合并时以 `add`（刚加入的这份）的价格/规格/单位为准整体覆盖，不是只加数量：
 * `add` 要么来自刚加载的商品网格（现价），要么来自"再来一单"/收藏夹核价对话框
 * 用户刚确认过的现价——购物车里如果已经躺着这个商品的旧价，两者取旧会让"核过价"
 * 的确认动作白做，最后仍按旧价结算。
 *
 * 20260926（code-review 发现）：去重键必须带上 `uomName`，不能只按 `productId`——
 * 同一商品的散称（KG）行和整箱（CASE）行是两个业务上完全不同的行，单价和数量都不共通，
 * 只按 productId 合并会把其中一行的单位/单价吞掉、只留数量相加，结算金额算错。
 * `uomId` 在这条链路上（订单历史 → 再来一单）目前没有查出来，`uomName` 是唯一
 * 全程都有值、能可靠区分单位的字段，先用它兜底。
 */
export function mergeCartItems(existing: CartItem[], additions: CartItem[]): CartItem[] {
  const result = [...existing]
  for (const add of additions) {
    const idx = result.findIndex((c) => c.productId === add.productId && c.uomName === add.uomName)
    if (idx >= 0) {
      result[idx] = { ...add, quantity: result[idx].quantity + add.quantity }
    } else {
      result.push(add)
    }
  }
  return result
}
