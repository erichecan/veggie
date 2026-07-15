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
  /**
   * 批次号(托盘号)。只有「打印单个托盘」这种场景才有唯一确定值(dispatch-loader 单批次分支)；
   * Trip 实体本身没有这个概念(一趟车可能横跨多个托盘)，筛选打印/全部打印同样无法归一到单个
   * 批次号——这两种情况都是 null，模板据此省略批次号，不再乱塞占位字符串。
   */
  batchNum?: number | null
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
  /** 该订单已开具的发票号（Invoice.name），未开票为 null */
  invoiceNo: string | null
  /**
   * 这一单实际所属的「批次号 时段 司机名」(如 "1 am AFZAAL")，来自 wave.orderIds 派生
   * (lib/wave-assign.ts SSOT，与销售单列表司机列同一口径)，查不到(未进任何波次)为 null。
   * 筛选打印/全部打印这类一次打印可能横跨多个司机的场景，trip 级 batchNum/driverName
   * 是空的，必须靠这个字段落到订单粒度才能显示正确司机——每单一页的送货单/销售单模板
   * 优先用它，取不到再退回 trip 级 formatTripDriverLabel。
   */
  driverBatchLabel: string | null
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

export const fmtQty = (v: number) =>
  v.toLocaleString('en-IE', { maximumFractionDigits: 3 })

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 模板末尾都内嵌了 <script>window.print()</script> 给客户端 iframe 打印用；
 * 无头 Chromium 走 page.pdf() 生成 PDF 时不需要也不能留着这段——window.print() 在无头模式下
 * 是同步阻塞调用，没有真实对话框可关，会把 page.setContent() 的 networkidle0 等待卡住。
 */
export function stripAutoPrintScript(html: string): string {
  return html.replace(/<script>\s*window\.print\(\);\s*<\/script>\s*/, '')
}

/**
 * 三张单(delivery/sales/picking/summary)统一的司机身份展示格式：「批次号 时段 司机名」
 * (如 "1 am AFZAAL")，与销售单列表司机列(lib/driver-slot.ts formatDriverSlot)同一口径。
 * 绝不拼 trip.name——那是行程备注/占位文案(如筛选打印时的"筛选批次 2026-07-10")，
 * 不是司机身份，拼进去要么重复司机名，要么把占位文案泄漏到客户可见的打印件上。
 */
export function formatTripDriverLabel(trip: TripBasic): string {
  return [
    trip.batchNum != null ? String(trip.batchNum) : '',
    trip.timeSlot?.toLowerCase() ?? '',
    trip.driverName ?? '',
  ].filter(Boolean).join(' ')
}

/**
 * 拣货单页头「司机/批次」展示：单一司机场景直接用 formatTripDriverLabel；筛选打印/全部打印
 * 横跨多个司机时(该函数返回空)，从各订单的 driverBatchLabel(wave 派生，订单粒度的真实司机身份)
 * 去重列出，不再显示 trip.name 里的"筛选批次"占位文案(客户反馈)。
 */
export function formatTripDriverList(trip: TripBasic, orders: TripOrder[]): string {
  const single = formatTripDriverLabel(trip)
  if (single) return single
  const labels = [...new Set(orders.map(o => o.driverBatchLabel).filter((x): x is string => !!x))]
  return labels.length > 0 ? labels.join('、') : '—'
}

/** 拣货单页头「Print at」时间戳：爱尔兰本地时区(自动处理 GMT/BST)，服务端渲染 PDF 那一刻/客户端打印那一刻 */
export function formatPrintTimestamp(date: Date | string | number = new Date()): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
  if (isNaN(d.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}`
}

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
