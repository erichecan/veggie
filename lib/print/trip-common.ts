/**
 * Trip 打印共享：类型 + 公共格式化工具（同构，无 Prisma 依赖）
 *
 * 这个文件**不能**导入 Prisma（被客户端组件用），server-only 的数据加载放在
 * trip-loader.ts（仅 API route 引用）。
 *
 * veggie/ 走客户端打印模式：API 返回 JSON → 前端组件渲染 → window.print()。
 */

export type GoodsType = 'BULK' | 'LOOSE' | null

export interface TripBasic {
  id: string
  name: string | null
  timeSlot: string | null
  driverName: string | null
  departTime: string | null
  createdAt: string
  /// 顶部提示横幅（如订单被截断时显示），无则为 null */
  notice?: string | null
}

export interface TripCustomer {
  id: string
  name: string
  street: string
  street2: string
  city: string | null
  state: string
  zip: string
  country: string
  phone: string
  vatNumber: string
  paymentTerm: string
  /** 客户级外部备注（客户可见，打印在送货单上） */
  externalNote: string | null
}

export interface TripLine {
  productId: string
  productName: string
  spec: string | null
  uomId: string | null
  uomName: string | null
  goodsType: GoodsType
  /** ProductTemplate.type: 'PRODUCT' | 'CONSU' | 'SERVICE' | null */
  productType?: string | null
  /** 行级备注（商品级 note，如"free"赠品/注意事项），客户可见，打印在明细行下 */
  note: string | null
  orderedQty: number
  unitPrice: number
  taxRate: number
  subtotal: number
}

export interface TripOrder {
  id: string
  code: string | null
  customerId: string
  customerName: string
  totalAmount: number
  internalNote: string | null
  /** 订单级外部备注（客户可见，打印在送货单上） */
  externalNote: string | null
  /** 第三方送货备注（第三方替我们送货时的具体信息，打印在送货单上） */
  deliveryNote: string | null
  deliveryDate: string | null
  lines: TripLine[]
}

/** API 返回 JSON 形态（Map 不能直接序列化，customers 用数组） */
export interface TripPrintDataWire {
  trip: TripBasic
  orders: TripOrder[]
  customers: TripCustomer[]
}

/** 客户端组件用的内存形态 — 数组形式 customers 转 Map */
export interface TripPrintData {
  trip: TripBasic
  orders: TripOrder[]
  customers: Map<string, TripCustomer>
}

/** 客户端：把 wire 形态转成方便的 Map 形态 */
export function toMemoryShape(wire: TripPrintDataWire): TripPrintData {
  return {
    trip: wire.trip,
    orders: wire.orders,
    customers: new Map(wire.customers.map(c => [c.id, c])),
  }
}

// ─── 公共格式化工具（三张单都用，纯函数，可同构） ──────────────────────────────

export const fmtMoney = (v: number) =>
  '€' + v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const fmtQty = (v: number) =>
  v.toLocaleString('en-IE', { maximumFractionDigits: 3 })

export const fmtDate = (v?: string | null) => {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export const fmtDateTime = (v?: string | null) => {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function timeSlotLabel(slot?: string | null): string {
  if (slot === 'AM') return '上午'
  if (slot === 'PM') return '下午'
  return slot ?? '—'
}

export function fullAddress(c: TripCustomer): string {
  return [c.street, c.street2, [c.city, c.state, c.zip].filter(Boolean).join(' '), c.country]
    .filter(Boolean).join('，')
}

const num = (v: unknown): number => {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 旧版 Order.items JSON 回退：当订单没有 OrderLine 记录时，用 items JSON 构造打印行。
 * items 形态：[{ productId, productName, spec, price, quantity, subtotal, uom? }]
 * 历史迁移订单 items 为空数组 → 返回 []（明细确实不存在，只在 Odoo）。
 */
export function buildLinesFromItems(items: unknown): TripLine[] {
  if (!Array.isArray(items)) return []
  return items.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>
    return {
      productId: String(it.productId ?? `item-${i}`),
      productName: String(it.productName ?? ''),
      spec: typeof it.spec === 'string' && it.spec ? it.spec : null,
      uomId: null,
      uomName: typeof it.uom === 'string' ? it.uom : (typeof it.uomName === 'string' ? it.uomName : null),
      goodsType: null,
      productType: null,
      note: typeof it.note === 'string' && it.note ? it.note : null,
      orderedQty: num(it.quantity),
      unitPrice: num(it.price),
      taxRate: num(it.taxRate),
      subtotal: num(it.subtotal),
    }
  })
}
