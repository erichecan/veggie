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
  /** 商品的 sequence（ProductTemplate.sequence）。打印排序按它，见 lib/print/line-sort.ts */
  productSequence?: number | null
  spec: string | null
  uomId: string | null
  uomName: string | null
  goodsType: GoodsType
  /** ProductTemplate.type: 'PRODUCT' | 'CONSU' | 'SERVICE' | null */
  productType?: string | null
  /** 行级备注（商品级 note，如"free"赠品/注意事项），客户可见，打印在明细行下 */
  note: string | null
  /** 箱规：1 箱 = 多少个基准单位。拣货单据此把总量拆成「N 箱 + M 散」(lib/pack-split.ts) */
  packSpec?: { factor: number; caseUomName: string; baseUomName: string } | null
  /**
   * 可售单位换算信息（DEV-PLAN 20260823 模块 B，原始数据，未格式化）：这一行选的单位
   * 不是基准单位时才有值。格式化成显示文字用 `formatUomConversionHint()`（lib/print/uom-conversion.ts）——
   * 拣货单要按聚合后的总量算，销售单/送货单/回单要按单行数量算，两者不能共用同一份预先拼好的字符串。
   * null = 选的就是基准单位，或商品没配这个可售单位（不显示）。
   */
  uomConversion?: import('./uom-conversion').UomConversionInfo | null
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
/**
 * 客户签收记录 —— 客户签收单（POD 回单）的数据来源。
 * 取自 Trip.restaurants JSON 里司机现场写入的签名，见 lib/trip-signature.ts。
 */
export interface TripSignoff {
  restaurantId: string
  restaurantName: string
  orderIds: string[]
  delivered: boolean
  /** 实收货款 */
  payment: number | null
  /** 手写签名 PNG data URI；未签收为 null */
  signature: string | null
  signerName: string | null
  /** 服务端打的签收时间（ISO） */
  signedAt: string | null
}

export interface TripPrintDataWire {
  trip: TripBasic
  orders: TripOrder[]
  customers: TripCustomer[]
  /** 每站签收状态。旧数据没有这个字段，模板需容忍 undefined */
  signoffs?: TripSignoff[]
}

/** 客户端组件用的内存形态 — 数组形式 customers 转 Map */
export interface TripPrintData {
  trip: TripBasic
  orders: TripOrder[]
  customers: Map<string, TripCustomer>
  signoffs?: TripSignoff[]
}

/** 客户端：把 wire 形态转成方便的 Map 形态 */
export function toMemoryShape(wire: TripPrintDataWire): TripPrintData {
  return {
    trip: wire.trip,
    orders: wire.orders,
    customers: new Map(wire.customers.map(c => [c.id, c])),
    signoffs: wire.signoffs,
  }
}

// ─── 公共格式化工具（三张单都用，纯函数，可同构） ──────────────────────────────

export const fmtQty = (v: number) =>
  v.toLocaleString('en-IE', { maximumFractionDigits: 3 })

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 纸面顶部的黄色提示条（截断 / 按筛选打印）。四种单据共用一份实现 ——
 * 原先只有送货单与销售单渲染 trip.notice，拣货单与汇总单静默忽略；
 * 而「只打了一部分」这件事恰恰是拣货单最需要说清楚的：
 * 仓库拿到一张没有提示的部分拣货单，会当成整车的全部去备货。
 */
export function renderTripNoticeHtml(notice?: string | null): string {
  if (!notice) return ''
  return `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:3mm 5mm;margin:0 auto 5mm;max-width:210mm;font-size:9pt;font-weight:bold;">⚠ ${escapeHtml(notice)}</div>`
}

/**
 * 模板末尾都内嵌了 <script>window.print()</script> 给客户端 iframe 打印用；
 * 无头 Chromium 走 page.pdf() 生成 PDF 时不需要也不能留着这段——window.print() 在无头模式下
 * 是同步阻塞调用，没有真实对话框可关，会把 page.setContent() 的 networkidle0 等待卡住。
 */
export function stripAutoPrintScript(html: string): string {
  return html.replace(/<script>\s*window\.print\(\);\s*<\/script>\s*/, '')
}

/**
 * 送货单/销售单每单一页，公司页头+客户/发票/送货信息块要在每一个物理打印页都重复
 * (客户反馈,20260716)。试过把页头塞进 <table><thead> 让浏览器自动跨页重复——
 * 无头 Chromium 的 page.pdf() 实测不支持(续页完全没有页头,且把 thead 拆成多行
 * colspan 还会把内层 info-table 的列宽算乱),所以改成手动按「一页能放多少行」
 * 分块：每一块单独渲染成一个 .page,页头在每块都重新画一次,块与块之间
 * page-break-after,这样每个物理页在渲染前就已经是独立的一页,不依赖浏览器的
 * 自动分页判断。行高预估宁可保守(留够余量)，宁可多分一页也不能真的溢出。
 */
const PRINT_PAGE_USABLE_MM = 272
/** 页头(公司抬头+客户/单号/送货信息块+表头)每页重画一次；条码与内边距收紧后的实测值 */
const PRINT_HEADER_OVERHEAD_MM = 78
/**
 * 单行高度预估。2026-08-18 行内边距 2mm→1.1mm、字号 9pt→8.5pt 之后从 9mm 降到 6mm，
 * 对应客户「一页至少 20 行」的要求（原先 (272-90-8)/9 ≈ 19 行/页，正是客户抱怨的数字）。
 * 6.3 不是 6：实测 6 会让 31 行的页真的溢出 1.4mm（行高实际约 6.05mm），
 * 6.3 留约 5% 余量，稳定在 29 行/页。
 *
 * ⛔ 改这两个数就必须同步改各模板 CSS 的行内边距/字号，反之亦然。预估**大于**实际
 *    只是浪费纸；预估**小于**实际会让内容真的溢出物理页 —— 这套模板是手工分页的，
 *    溢出不会自动换页，只会被切掉或压住页脚。改完跑 scripts/print/measure-print-page.ts。
 */
const PRINT_ROW_BASE_MM = 6.3
const PRINT_ROW_EXTRA_LINE_MM = 3.4
/** 每页页脚(单据编码 - Page X/Y)预留高度，单行小字，比页头保守估算小很多 */
const PRINT_FOOTER_OVERHEAD_MM = 8

/**
 * 通用打印分页器：按每行预估高度(mm)把 rows 切块，块内累计高度不超过 availableMm，
 * 保证每块能刚好放进一张物理打印页(单块至少 1 行，避免死循环)。
 * chunkOrderLinesForPrint(订单明细行)、汇总单(整单一行)等场景共用同一套切块逻辑，
 * 只是每行高度的估算函数不同。
 */
export function chunkRowsForPrint<T>(
  rows: T[],
  estimateHeightMm: (row: T) => number,
  availableMm: number,
): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let currentHeight = 0
  for (const r of rows) {
    const h = estimateHeightMm(r)
    if (current.length > 0 && currentHeight + h > availableMm) {
      chunks.push(current)
      current = []
      currentHeight = 0
    }
    current.push(r)
    currentHeight += h
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 把订单明细行切成「每块正好一张物理页」。
 *
 * @param footerOverheadMm **每一页**都要预留的页脚高度，默认按"单据编码 - Page X/Y"
 *   那行小字算。
 * @param lastPageExtraMm  只有**最后一页**才有的尾部内容（合计、Payment 徽章、
 *   最多 3 个备注框）额外预留的高度。
 *
 * ⛔ 这两个参数必须分开：改造前三个调用方都把「最后一页才有的 72–80mm」当成每页的
 *    footerOverhead 传进来，于是**每一页都白留 80mm**，一页只印得下 19 行 ——
 *    客户「一页至少 20 行」的抱怨有一半是这么来的。
 */
export function chunkOrderLinesForPrint<T extends { spec?: string | null; note?: string | null }>(
  lines: T[],
  footerOverheadMm: number = PRINT_FOOTER_OVERHEAD_MM,
  lastPageExtraMm: number = 0,
): T[][] {
  const rowHeight = (l: T) =>
    PRINT_ROW_BASE_MM + ((l.spec ? 1 : 0) + (l.note ? 1 : 0)) * PRINT_ROW_EXTRA_LINE_MM
  const heightOf = (rows: T[]) => rows.reduce((sum, l) => sum + rowHeight(l), 0)

  const available = PRINT_PAGE_USABLE_MM - PRINT_HEADER_OVERHEAD_MM - footerOverheadMm
  const chunks = chunkRowsForPrint(lines, rowHeight, available)
  if (lastPageExtraMm <= 0 || chunks.length === 0) return chunks

  // 尾部内容只压最后一页，所以只有最后一块按更小的可用高度收；放不下就把尾巴上的
  // 行推到新的一块。
  //
  // ⚠️ 只推「必要的最少行数」：前面的页不是最后一页，只要 ≤ available 就合法，该塞满
  //    就塞满。写这段时第一版把原块也收到 lastAvailable，30 行的单被切成 13+17，
  //    首页比改造前还空 —— 与「一页尽可能多印」正好相反。
  const lastAvailable = available - lastPageExtraMm
  for (;;) {
    const last = chunks[chunks.length - 1]
    if (heightOf(last) <= lastAvailable || last.length <= 1) break
    const moved: T[] = []
    let movedH = 0
    while (last.length > 1) {
      const row = last[last.length - 1]
      const rh = rowHeight(row)
      if (movedH + rh > lastAvailable) break   // 新的最后一页装不下更多了
      moved.unshift(last.pop() as T)
      movedH += rh
      if (heightOf(last) <= available) break   // 前一页已经合法 —— 别再多搬，让它满着
    }
    if (moved.length === 0) break              // 搬不动（单行超高），避免死循环
    chunks.push(moved)
  }
  return chunks
}

/**
 * 每页页脚统一格式："单据编码 - Page 当前页/总页数"——不管这叠纸后续被打乱成什么顺序，
 * 靠页脚就能唯一定位归属订单与相对位置(客户要求,20260718)。docCode 传订单号/单据编号；
 * 页脚渲染在 .page 内部(需要 .page 是 position:relative)，不能用 position:fixed——
 * 那样整份多页文档只有一份内容，没法按块显示不同的当前页码。
 */
export function renderPageNumberFooter(docCode: string, pageNum: number, totalPages: number): string {
  return `<div class="print-page-footer">${escapeHtml(docCode)} - Page ${pageNum}/${totalPages}</div>`
}

export const PRINT_PAGE_FOOTER_CSS = `
.print-page-footer { position: absolute; left: 0; right: 0; bottom: 4mm; text-align: center; font-size: 8pt; color: #666; }
`

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
