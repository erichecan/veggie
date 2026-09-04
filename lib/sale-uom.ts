import { round2 } from '@/lib/decimal-helpers'

/**
 * 商品可售单位（多规格）的校验与换算 —— 唯一口径
 * ============================================================================
 * 20260819 起，换算系数 `factor` 挂在 `ProductSaleUom` 上，不再用全局 `Uom.factor`。
 *
 * 为什么：`ASIAN CHOICE Black Tiger Shrimp 10*700g CASE`（箱装 10 包）与
 * `Chuannan Pickled Vegetable 30*62g CASE`（箱装 30 包）在生产库里都叫 CASE。
 * 「1 CASE 等于多少」是**商品**的属性。全局 Uom.factor 在生产库 Unit 类目下
 * 干脆全是 1，多规格因此形同虚设 —— 切了单位价格不变、库存也不换算。
 *
 * 库存口径（客户 20260819 拍板）：`Product.qtyOnHand` 按**基础单位**计数，
 * 基础单位 = `isDefault` 那一行，其 factor 恒为 1。
 */

export type SaleUomPriceMode = 'AUTO' | 'FIXED' | 'FORMULA'

export interface SaleUomItemInput {
  uomId?: string
  isDefault?: boolean
  /** 1 个此单位 = factor 个基础单位 */
  factor?: number | string | null
  priceOverride?: number | string | null
  active?: boolean
  /** 价格计算方式；默认 AUTO 与不填这个字段的历史行为完全一致 */
  priceMode?: SaleUomPriceMode
  /** FORMULA 模式下按基准价加减的百分比（可正可负，正=加价，负=打折）；20260823 由"折扣"改成"加减"语义 */
  priceDiscountPct?: number | string | null
  /** FORMULA 模式下再加减的绝对金额（可正可负） */
  priceSurcharge?: number | string | null
  /** 提成价照抄价格机制（20260901）：留空按 AUTO 用「基础提成价 × factor」自动折算 */
  commissionPriceOverride?: number | string | null
  commissionPriceMode?: SaleUomPriceMode
  commissionDiscountPct?: number | string | null
  commissionSurcharge?: number | string | null
}

/** factor 的合理区间。上限 100000 足够覆盖「1 托盘 = N 个最小包装」这类真实场景 */
const FACTOR_MIN = 0.000001
const FACTOR_MAX = 100000

/**
 * 校验一组可售单位配置：单位不重复、恰好一个默认、默认单位系数必须为 1、
 * 其余系数与独立售价在合理区间。返回错误信息，无误返回 null。
 */
export function validateSaleUomItems(items: SaleUomItemInput[]): string | null {
  const uomIds = items.map(it => String(it.uomId ?? ''))
  if (new Set(uomIds).size !== uomIds.length) return '同一单位不能重复配置'
  const defaultCount = items.filter(it => it.isDefault).length
  if (items.length > 0 && defaultCount !== 1) return '必须且只能有一个默认单位'

  for (const it of items) {
    if (!it.uomId) return '单位不能为空'

    if (it.priceOverride != null && it.priceOverride !== '') {
      const n = Number(it.priceOverride)
      if (!Number.isFinite(n) || n < 0 || n > 1000000) return '独立售价必须在 0–1,000,000 之间'
    }

    if (it.priceMode === 'FORMULA') {
      const d = it.priceDiscountPct == null || it.priceDiscountPct === '' ? 0 : Number(it.priceDiscountPct)
      if (!Number.isFinite(d) || d < 0 || d > 100) return '折扣百分比必须在 0–100 之间'
      const s = it.priceSurcharge == null || it.priceSurcharge === '' ? 0 : Number(it.priceSurcharge)
      if (!Number.isFinite(s) || s < -1000000 || s > 1000000) return '加减金额必须在 −1,000,000–1,000,000 之间'
    }

    if (it.commissionPriceOverride != null && it.commissionPriceOverride !== '') {
      const n = Number(it.commissionPriceOverride)
      if (!Number.isFinite(n) || n < 0 || n > 1000000) return '独立提成价必须在 0–1,000,000 之间'
    }

    if (it.commissionPriceMode === 'FORMULA') {
      // ⚠️ 不能照抄 priceDiscountPct 的 0–100 下限：那条校验只认「折扣」不认「负数=折扣」，
      // 跟价格公式编辑器自己的 UI 提示（"负数就是打折"）互相矛盾，本身就是一个既有的校验漏洞。
      // 提成这里既然从头设计，直接按公式的真实语义来——pct=-100 时 (1+pct/100)=0，提成正好归零，
      // 再往下没意义所以设成下限；上限给一个宽松但有限的值，防止误填出天文数字。
      const d = it.commissionDiscountPct == null || it.commissionDiscountPct === '' ? 0 : Number(it.commissionDiscountPct)
      if (!Number.isFinite(d) || d < -100 || d > 1000) return '提成百分比调整必须在 −100–1000 之间'
      const s = it.commissionSurcharge == null || it.commissionSurcharge === '' ? 0 : Number(it.commissionSurcharge)
      if (!Number.isFinite(s) || s < -1000000 || s > 1000000) return '提成加减金额必须在 −1,000,000–1,000,000 之间'
    }

    const f = it.factor == null || it.factor === '' ? 1 : Number(it.factor)
    if (!Number.isFinite(f) || f < FACTOR_MIN || f > FACTOR_MAX) {
      return `换算系数必须在 ${FACTOR_MIN} – ${FACTOR_MAX} 之间`
    }
    // 基础单位是库存的计数尺子，它自己对自己的换算只能是 1。
    // 允许填别的值等于让「1 包 = 2 包」，库存会立刻算错。
    if (it.isDefault && f !== 1) return '默认单位就是库存的计数单位，换算系数必须为 1'
  }
  return null
}

/** 从输入里取出规范化的 factor（空/非法一律回落到 1，与改造前行为一致） */
export function normalizeFactor(raw: number | string | null | undefined): number {
  if (raw == null || raw === '') return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < FACTOR_MIN || n > FACTOR_MAX) return 1
  return n
}

export interface SaleUomRow {
  uomId: string
  isDefault: boolean
  factor: number
  priceOverride: number | null
  active?: boolean
  priceMode?: SaleUomPriceMode
  priceDiscountPct?: number
  priceSurcharge?: number
  commissionPriceOverride?: number | null
  commissionPriceMode?: SaleUomPriceMode
  commissionDiscountPct?: number
  commissionSurcharge?: number
}

/**
 * 某一行选用 `lineUomId` 时，1 个该单位等于多少个基础单位。
 *
 * 没配多规格、或选的就是基础单位 → 返回 1（与多规格上线前逐字一致，
 * 5474 个从未配过多规格的商品完全不受影响）。
 */
export function factorOf(saleUoms: SaleUomRow[], lineUomId: string | null | undefined): number {
  if (!lineUomId || saleUoms.length === 0) return 1
  const hit = saleUoms.find(r => r.uomId === lineUomId)
  if (!hit) return 1
  return hit.factor > 0 ? hit.factor : 1
}

/**
 * 某一行选用 `lineUomId` 时的单价。
 *
 * 20260823 起按 `priceMode` 三态分支：
 * - FIXED：直接用 `priceOverride`（整箱优惠价这类场景）
 * - FORMULA：`基准单价 × factor × (1 + priceDiscountPct/100) + priceSurcharge`
 *   20260823 由"减"改"加"：priceDiscountPct 现在正数=加价、负数=打折，跟界面上
 *   「price = base price + 百分比(可负) + 绝对值(可负)」的公式描述一一对应。
 * - AUTO（含 priceMode 未传的旧调用点）：与改造前逐字一致 ——
 *   `priceOverride` 有值就用，否则按「基础单价 × factor」换算。
 *   这保证 5474 个从没配过多规格、以及所有存量已配置行的计算结果一个数字都不变。
 */
export function priceOf(
  saleUoms: SaleUomRow[],
  lineUomId: string | null | undefined,
  basePrice: number,
): number {
  if (!lineUomId || saleUoms.length === 0) return basePrice
  const hit = saleUoms.find(r => r.uomId === lineUomId)
  if (!hit) return basePrice
  // ⚠️ 必须舍入：1.20 × 3 在浮点里是 3.5999999999999996。
  // 落库时 Decimal(12,2) 会截断掉，但界面上会**原样显示**这一串 ——
  // 客户看到报价单上写 €3.5999999999999996 就没法用了。
  const factor = hit.factor > 0 ? hit.factor : 1
  if (hit.priceMode === 'FIXED') {
    return hit.priceOverride != null ? hit.priceOverride : round2(basePrice * factor)
  }
  if (hit.priceMode === 'FORMULA') {
    const pct = hit.priceDiscountPct ?? 0
    const surcharge = hit.priceSurcharge ?? 0
    return round2(basePrice * factor * (1 + pct / 100) + surcharge)
  }
  if (hit.priceOverride != null) return hit.priceOverride
  return round2(basePrice * factor)
}

/**
 * 某一行选用 `lineUomId` 时的司机提成单价（20260901）。
 *
 * 逐字镜像 `priceOf()`——同样的三态分支、同样的 factor 折算、同样要四舍五入两位小数。
 * 唯一区别：提成价可以是 `null`（该商品不计件提成），null 沿基础值原样传导，
 * 不会因为配了可售单位就凭空造出一个提成来。
 *
 * 没配多规格、或选的就是基础单位 → 原样返回 `baseCommissionPrice`（与改造前
 * "提成只按 factor 线性折算"逐字一致，未特意配置的商品/可售单位完全不受影响）。
 */
export function commissionPriceOf(
  saleUoms: SaleUomRow[],
  lineUomId: string | null | undefined,
  baseCommissionPrice: number | null,
): number | null {
  if (!lineUomId || saleUoms.length === 0) return baseCommissionPrice
  const hit = saleUoms.find(r => r.uomId === lineUomId)
  if (!hit) return baseCommissionPrice
  const factor = hit.factor > 0 ? hit.factor : 1
  const base = baseCommissionPrice ?? 0
  if (hit.commissionPriceMode === 'FIXED') {
    if (hit.commissionPriceOverride != null) return hit.commissionPriceOverride
    return baseCommissionPrice == null ? null : round2(base * factor)
  }
  if (hit.commissionPriceMode === 'FORMULA') {
    if (baseCommissionPrice == null && hit.commissionPriceOverride == null) return null
    const pct = hit.commissionDiscountPct ?? 0
    const surcharge = hit.commissionSurcharge ?? 0
    return round2(base * factor * (1 + pct / 100) + surcharge)
  }
  // AUTO（含未配置 commissionPriceMode 的旧行为）
  if (hit.commissionPriceOverride != null) return hit.commissionPriceOverride
  return baseCommissionPrice == null ? null : round2(base * factor)
}

/** 基础单位（库存计数单位）；没配多规格时为 null */
export function baseUomId(saleUoms: SaleUomRow[]): string | null {
  return saleUoms.find(r => r.isDefault)?.uomId ?? null
}

/**
 * 商品没配基准单位（`ProductTemplate.uomId` 为空）时的兜底单位名。
 *
 * ⚠️ 20260823（DEV-PLAN 决策#1）：故意带 `⚠` 前缀，不能是干净的 "Unit(s)" ——
 * 同一商品的历史订单行，有的是在配了基准单位之后下的（显示真实单位名如 CASE），
 * 有的是在那之前下的（显示这个兜底值），两行印在同一张拣货单/送货单上，干净的
 * "Unit(s)" 看起来就像一个正常的第三方单位，拣货员没法分辨那其实是"没配"。
 * 加了 `⚠` 前缀后，无论出现在下单页的单位下拉框、行内标签，还是打印单据的单位列，
 * 都一眼能看出"这行数据不完整"，而不是被当成又一种合法单位。
 */
export const UNSET_UOM_LABEL = '⚠ Unit(s)'

/**
 * 打印/展示单据时统一走这个函数取单位名，而不是直接读 `uomName` 字段——
 * 历史订单行（20260823 之前下的）落库的兜底值是不带 `⚠` 的纯 "Unit(s)"，
 * 直接显示会跟同一商品配了基准单位后的真实单位名（如 "CASE"）混在一起看不出区别，
 * 这里统一按当前口径重新打上标记，不需要一次性改历史数据。
 */
export function displayUomName(uomName: string | null | undefined): string {
  if (!uomName || uomName === 'Unit(s)') return UNSET_UOM_LABEL
  return uomName
}

/**
 * 加商品/编辑订单行的共用逻辑（20260904 抽取）
 * ============================================================================
 * 三个订单页（下单页 place-order、报价单编辑页 quotations/[id]、销售单编辑页 orders/[id]）
 * 各自复制粘贴了一份几乎逐字相同的"加商品该落哪个单位""判重""合并重复行"逻辑——
 * 直接后果是 20260904 客户反馈的一个 bug（选品第三次起被静默合并进已有行、新单位那行
 * 凭空消失）只改了其中一份就漏了另外两份。现在收口到这一处，往后同类 bug 只用改一处。
 *
 * ⚠️ 定价计算（selectProductIntoLine 里查最近成交价/套定价引擎那部分）三个页面的实现
 * 仍分开——那部分本来就在往不同方向演化（quotations/orders 两级历史价回退 vs. place-order
 * 的 computeLinePrice），贸然拉平风险和工作量都远大于这次真正出问题的部分，不在本次收口范围内。
 */

/** 判重的最小行形状：productId 未选品时可能是空字符串/undefined，uomId 允许 null。 */
export interface DupKeyLine {
  productId?: string | null
  uomId?: string | null
}

/** 商品+单位的判重键。三页原先各自手写 `${l.productId}__${l.uomId ?? ''}`，逐字一致。 */
export function dupKey(l: DupKeyLine): string {
  return `${l.productId ?? ''}__${l.uomId ?? ''}`
}

/** 统计编辑缓冲区里每个 (productId, uomId) 组合出现了几次，供"重复商品提醒"横幅与行高亮共用。 */
export function computeDuplicateCounts<T extends DupKeyLine>(lines: T[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const l of lines) {
    if (!l.productId) continue
    const key = dupKey(l)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * 手动「合并重复项」：同一 productId+uomId 的行合并成一行，数量相加，保留先出现那行的其它字段。
 * `afterMerge` 供调用方在数量改完后补算派生字段（如 EditLine 的 subtotal；place-order 的
 * QuotationLine 没有存 subtotal 字段，不需要传）。
 */
export function mergeDuplicateLines<T extends DupKeyLine & { orderedQty: number }>(
  lines: T[],
  afterMerge?: (line: T) => void,
): T[] {
  const seen = new Map<string, T>()
  const result: T[] = []
  for (const l of lines) {
    if (!l.productId) { result.push(l); continue }
    const key = dupKey(l)
    const existing = seen.get(key)
    if (existing) {
      // Number() 强制转换：orderedQty 类型标的是 number，但过一遍 JSON 序列化的行
      // （EditLine 来自 API 响应）历史上出现过以字符串落地的情况，直接 `+` 会变成拼接。
      existing.orderedQty = Number(existing.orderedQty) + Number(l.orderedQty)
      afterMerge?.(existing)
    } else {
      const copy = { ...l }
      seen.set(key, copy)
      result.push(copy)
    }
  }
  return result
}

/** 一个商品可选的可售单位；对应 GET /api/products/[id]/sale-uoms 拉回来整形后的形状。 */
export interface SaleUomOption {
  uomId: string
  uomName: string
  isDefault?: boolean
  factor: number
  priceOverride: number | null
  priceMode: SaleUomPriceMode
  priceDiscountPct: number
  priceSurcharge: number
  active: boolean
}

/**
 * 加商品时该落哪个单位：基础单位若被关掉(active=false)不能再默认用它——落到第一个仍
 * active 的额外单位；没有任何可下单单位时 blocked=true，调用方应拒绝加行，而不是
 * 静默塞一个禁用单位进去。
 *
 * ⚠️ 这只解决"该用哪个单位当默认值"，不知道、也不该猜用户到底想要哪个单位——
 * 那是"加商品"这一步先天做不到的事（商品搜索列表里一个商品只有一条，不按单位拆开）。
 * 真正想要别的单位，加完之后用行内「Unit of Measure」下拉切换（switchLineUnit，三页各自实现，
 * 不在本次收口范围）。
 */
export function resolveAddableUom(
  p: { id: string; uomId?: string | null; uomName?: string | null },
  opts: SaleUomOption[],
): { uomId?: string; uomName: string; blocked: boolean } {
  const baseUomId = p.uomId ?? undefined
  const baseRow = opts.find(o => o.uomId === baseUomId)
  const baseActive = baseRow ? baseRow.active : true
  if (!baseUomId || baseActive) {
    return { uomId: baseUomId, uomName: p.uomName ?? UNSET_UOM_LABEL, blocked: false }
  }
  const firstActiveExtra = opts.find(o => o.uomId !== baseUomId && o.active)
  if (firstActiveExtra) {
    return { uomId: firstActiveExtra.uomId, uomName: firstActiveExtra.uomName, blocked: false }
  }
  return { uomId: undefined, uomName: UNSET_UOM_LABEL, blocked: true }
}
