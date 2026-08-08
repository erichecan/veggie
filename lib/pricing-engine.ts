/**
 * Odoo Pricelist 定价引擎（完整复刻）
 *
 * 优先级：
 *   1. 按 sequence 排序的 items，第一个匹配的条目生效
 *   2. applyOn: 'variant' > 'product' > 'category' > 'global'（sequence 保证顺序）
 *   3. minQty 过滤
 *   4. dateStart / dateEnd 过滤
 *   5. formulaBase='pricelist' 时递归求价，最多深度 5 防循环
 *
 * 未匹配任何条目时回退到 product.listPrice ?? product.price ?? 0
 */

import type { Product, OdooPricelist, OdooPricelistItem, Customer, CustomerPriceType } from './types'
import { fmtMoney } from './format-money'

// ─── 公共接口 ─────────────────────────────────────────────────────────────────

/** 价格来源分类，用于 UI 展示"这个价格是哪来的"，不依赖 pricelistName/itemDesc 的自然语言文本猜测 */
export type PriceSourceKind = 'pricelist' | 'special' | 'last' | 'default'

export interface PriceResolution {
  /** 最终价格 */
  price: number
  /** 触发的 pricelist 名称 */
  pricelistName: string
  /** 触发的条目描述（方便调试/展示） */
  itemDesc: string
  /** 是否是默认牌价（未命中任何条目） */
  isFallback: boolean
  /** 是否由客户专属特殊价格触发（最高优先级） */
  isSpecialPrice?: boolean
  /** 价格来源分类：pricelist=命中价格表 / special=客户专属价 / last=最近成交价 / default=牌价兜底 */
  sourceType: PriceSourceKind
}

// ─── 主函数 ───────────────────────────────────────────────────────────────────

/**
 * 根据价格表为指定商品计算最终价格
 *
 * @param product       商品变体对象
 * @param pricelist     要应用的价格表
 * @param allPricelists 全部价格表（用于嵌套 pricelist formulaBase）
 * @param qty           购买数量（影响 minQty 过滤）
 * @param date          询价日期（影响 dateStart/dateEnd，默认今天）
 * @param _depth        内部递归深度计数器，外部不要传
 */
export function resolvePrice(
  product: Product,
  pricelist: OdooPricelist,
  allPricelists: OdooPricelist[],
  qty = 1,
  date?: string,
  _depth = 0,
): PriceResolution {
  const basePrice = product.listPrice ?? product.price ?? 0
  const today = date ?? new Date().toISOString().slice(0, 10)

  if (_depth > 5) {
    return {
      price: basePrice,
      pricelistName: pricelist.name,
      itemDesc: '递归深度超限，回退到牌价',
      isFallback: true,
      sourceType: 'pricelist',
    }
  }

  const items = [...pricelist.items].sort((a, b) => a.sequence - b.sequence)

  for (const item of items) {
    if (qty < item.minQty) continue
    if (item.dateStart && today < item.dateStart) continue
    if (item.dateEnd && today > item.dateEnd) continue
    if (!matchesItem(item, product)) continue
    // 防止嵌套递归超过深度限制：当已接近深度限制时，跳过引用其他价格表的项
    if (_depth >= 5 && item.computeType === 'formula' && item.formulaBase === 'pricelist') continue

    const computed = computeItemPrice(item, product, basePrice, allPricelists, qty, date, _depth)
    if (computed === null) continue

    return {
      price: round2(computed),
      pricelistName: pricelist.name,
      itemDesc: describeItem(item),
      isFallback: false,
      sourceType: 'pricelist',
    }
  }

  return {
    price: round2(basePrice),
    pricelistName: pricelist.name,
    itemDesc: '未匹配任何规则，使用牌价',
    isFallback: true,
    sourceType: 'pricelist',
  }
}

/**
 * 按客户配置的价格表优先级链依次尝试，命中第一张就停。
 * @param orderedPricelistIds 已按 sequence 升序排好的 pricelistId 列表
 * @returns 命中的 PriceResolution；全部未命中返回 null（调用方决定下一步回退到哪）
 */
function resolveViaPricelistChain(
  product: Product,
  orderedPricelistIds: string[],
  allPricelists: OdooPricelist[],
  qty: number,
): PriceResolution | null {
  for (const plId of orderedPricelistIds) {
    const pl = allPricelists.find(p => p.id === plId)
    if (!pl) continue
    const r = resolvePrice(product, pl, allPricelists, qty)
    if (!r.isFallback) return r
  }
  return null
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

/** 判断 item 是否匹配商品变体 */
function matchesItem(item: OdooPricelistItem, product: Product): boolean {
  switch (item.applyOn) {
    case 'global':
      return true
    case 'product':
      // 匹配商品模板（product.template = product.templateId）
      return item.productTemplateId !== undefined && item.productTemplateId === product.templateId
    case 'variant':
      // 匹配具体变体
      return item.productVariantId !== undefined && item.productVariantId === product.id
    case 'category':
      return item.categoryId !== undefined && item.categoryId === product.categoryId
    default:
      return false
  }
}

/**
 * 根据条目计算价格
 * 返回 null 表示无法计算（如 pricelist formulaBase 但找不到目标表）
 */
function computeItemPrice(
  item: OdooPricelistItem,
  product: Product,
  basePrice: number,
  allPricelists: OdooPricelist[],
  qty: number,
  date: string | undefined,
  depth: number,
): number | null {
  switch (item.computeType) {
    case 'fixed':
      return item.fixedPrice ?? null

    case 'percentage': {
      const discount = item.percentDiscount ?? 0
      return basePrice * (1 - discount / 100)
    }

    case 'formula': {
      let formulaBase: number
      switch (item.formulaBase) {
        case 'list_price':
          formulaBase = basePrice
          break
        case 'standard_price':
          formulaBase = product.standardPrice ?? product.commissionPrice ?? basePrice
          break
        case 'pricelist': {
          if (!item.basedOnPricelistId) return null
          const nested = allPricelists.find(pl => pl.id === item.basedOnPricelistId)
          if (!nested) return null
          // 如果再往下一层会超过深度限制，直接返回 null 让外层回退
          if (depth >= 5) return null
          const nestedResult = resolvePrice(product, nested, allPricelists, qty, date, depth + 1)
          if (nestedResult.isFallback) return null  // If nested call fell back, we should too
          formulaBase = nestedResult.price
          break
        }
        default:
          formulaBase = basePrice
      }

      // Odoo 的 price_limit：**基准价本身**，在折扣/加价之前捕获。
      // 下面两条 margin 都相对它，而不是相对商品进价。
      const priceLimit = formulaBase

      let price = formulaBase * (1 - (item.priceDiscount ?? 0) / 100)
      // Odoo 的顺序是「折扣 → 舍入 → 加价 → margin 夹取」，不能随意调换：
      // 先加价再舍入会把加价一起round掉，结果对不上 Odoo。
      if (item.roundingMethod) price = roundToStep(price, item.roundingMethod)
      price += item.priceSurcharge ?? 0

      // ⛔ 这里必须用**真值**判断，不能用 `!== undefined`。
      //
      // Odoo 写的是 `if rule.price_min_margin:` —— 0 在 Python 里是 falsy，
      // 所以「利润 0」的含义是**不设限**，不是「利润必须正好为 0」。
      // 用 `!== undefined` 的话，min 和 max 同时为 0 会变成
      // `min(max(价, 基准), 基准)`，恒等于基准价 —— 20260808 客户实测到的
      // 「CITY CENTREtest 嵌套 M7N3M1test 却跳出 COST PRICE」就是这么来的
      // （当时还错把基准取成了进价，两个 bug 叠在一起，结果正好是进价）。
      // 而 UI 上把「最低利润」填 0 是个再自然不过的动作。
      if (item.priceMinMargin) price = Math.max(price, priceLimit + item.priceMinMargin)
      if (item.priceMaxMargin) price = Math.min(price, priceLimit + item.priceMaxMargin)
      return price
    }

    default:
      return null
  }
}

/** 生成条目的人类可读描述 */
function describeItem(item: OdooPricelistItem): string {
  const scope =
    item.applyOn === 'global' ? '全局' :
    item.applyOn === 'product' ? `商品模板 ${item.productTemplateId}` :
    item.applyOn === 'variant' ? `变体 ${item.productVariantId}` :
    item.applyOn === 'category' ? `分类 ${item.categoryId}` : item.applyOn

  const qty = item.minQty > 0 ? `，最小数量 ${item.minQty}` : ''

  switch (item.computeType) {
    case 'fixed':
      return `${scope}：固定价 €${fmtMoney(item.fixedPrice)}${qty}`
    case 'percentage':
      return `${scope}：折扣 ${item.percentDiscount}%${qty}`
    case 'formula': {
      const base =
        item.formulaBase === 'standard_price' ? '进价' :
        item.formulaBase === 'pricelist' ? `价格表 ${item.basedOnPricelistId}` : '牌价'
      const disc = item.priceDiscount ? `，再 -${item.priceDiscount}%` : ''
      const surcharge = item.priceSurcharge ? `，+€${fmtMoney(item.priceSurcharge)}` : ''
      return `${scope}：基于${base}${disc}${surcharge}${qty}`
    }
    default:
      return scope
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 按步长舍入，对应 Odoo 的 `float_round(price, precision_rounding=rule.price_round)`。
 * 步长 0.05 表示"取整到最近的 5 分"。
 *
 * 这个字段（UI 上的「舍入精度」）在 20260808 之前**引擎根本没读**：
 * 页面上可以填、能存进库，但对价格毫无影响 —— 一个不生效的开关比没有更糟，
 * 因为设置的人以为它生效了。
 */
function roundToStep(value: number, step: number): number {
  if (!step || step <= 0) return value
  return Math.round(value / step) * step
}

// ─── 便捷工具：按客户 pricelistId 解析最终价格 ────────────────────────────────

export const PRICE_TYPE_LABEL: Record<CustomerPriceType, string> = {
  multi:   '价格表定价',
  default: '直接牌价',
  last:    '最近成交价',
}

/**
 * 根据客户定价模式计算商品最终价格
 *
 * 优先级（从高到低）：
 *   1. customer.specialPrices — 客户专属特殊价格（最高优先级，无论 priceType）
 *   2. priceType 决定后续策略：
 *      - 'multi'   → 价格表链 → last price → 牌价，三级回退
 *      - 'default' → 价格表链 → 牌价，两级回退（不查 last price）
 *      - 'last'    → 使用传入的 lastPrice（调用方需从 API 获取）；若无则回退牌价
 *
 * @param lastPrice  priceType='last' 时传入该客户+商品最近一笔成交价，由调用方查询
 */
export function resolveCustomerPrice(
  product: Product,
  customer: Customer,
  allPricelists: OdooPricelist[],
  qty = 1,
  lastPrice?: number,
): PriceResolution {
  const basePrice = product.listPrice ?? product.price ?? 0
  const today = new Date().toISOString().slice(0, 10)
  // Sprint 3: normalize priceType to lowercase (support MULTI/LAST/DEFAULT uppercase aliases)
  const priceType: CustomerPriceType = ((customer.priceType ?? 'multi').toLowerCase() as CustomerPriceType)

  // ── 第一优先级：客户专属特殊价格（所有 priceType 均适用） ─────────────────
  if (customer.specialPrices && customer.specialPrices.length > 0) {
    const matching = customer.specialPrices
      .filter(sp => {
        if (sp.productId !== product.id) return false
        if (qty < sp.minQty) return false
        if (sp.dateStart && today < sp.dateStart) return false
        if (sp.dateEnd && today > sp.dateEnd) return false
        return true
      })
      .sort((a, b) => b.minQty - a.minQty)

    if (matching.length > 0) {
      const sp = matching[0]
      const noteStr = sp.note ? `（${sp.note}）` : ''
      return {
        price: round2(sp.fixedPrice),
        pricelistName: '客户专属特殊价格',
        itemDesc: `专属固定价 €${fmtMoney(sp.fixedPrice)}${sp.minQty > 0 ? `，最小数量 ${sp.minQty}` : ''}${noteStr}`,
        isFallback: false,
        isSpecialPrice: true,
        sourceType: 'special',
      }
    }
  }

  // ── 第二优先级：按 priceType 分支 ─────────────────────────────────────────

  const orderedPricelistIds = (customer.pricelists ?? [])
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(link => link.pricelistId)

  // default：先查价格表链，未命中才回退牌价（不查 last price）
  if (priceType === 'default') {
    const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty)
    if (viaChain) return viaChain
    return {
      price: round2(basePrice),
      pricelistName: orderedPricelistIds.length > 0 ? '价格表链未命中' : '直接牌价',
      itemDesc: orderedPricelistIds.length > 0
        ? '客户定价模式：先查价格表，未命中任何规则，回退牌价'
        : '客户定价模式：直接牌价（未挂价格表）',
      isFallback: true,
      sourceType: 'default',
    }
  }

  // last：用该客户最近一笔成交价
  if (priceType === 'last') {
    if (lastPrice !== undefined && lastPrice > 0) {
      return {
        price: round2(lastPrice),
        pricelistName: '最近成交价',
        itemDesc: `最近一次售价 €${fmtMoney(lastPrice)}`,
        isFallback: false,
        sourceType: 'last',
      }
    }
    // 若查不到历史成交价，回退牌价
    return {
      price: round2(basePrice),
      pricelistName: '最近成交价（无历史，回退牌价）',
      itemDesc: '该客户从未购买此商品，回退到牌价',
      isFallback: true,
      sourceType: 'default',
    }
  }

  // multi（默认）：价格表链 → lastPrice → listPrice
  const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty)
  if (viaChain) return viaChain

  if (lastPrice !== undefined && lastPrice > 0) {
    const fromDesc = orderedPricelistIds.length > 0 ? '价格表链未命中' : '无价格表'
    return {
      price: round2(lastPrice),
      pricelistName: '最近成交价',
      itemDesc: `${fromDesc}，改用最近售价 €${fmtMoney(lastPrice)}`,
      isFallback: false,
      sourceType: 'last',
    }
  }

  return {
    price: round2(basePrice),
    pricelistName: '牌价',
    itemDesc: orderedPricelistIds.length > 0
      ? '价格表链未命中，且无历史成交价，使用牌价'
      : '客户未关联价格表，使用牌价',
    isFallback: true,
    sourceType: 'default',
  }
}
