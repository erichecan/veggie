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

// ─── 公共接口 ─────────────────────────────────────────────────────────────────

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
    }
  }

  return {
    price: round2(basePrice),
    pricelistName: pricelist.name,
    itemDesc: '未匹配任何规则，使用牌价',
    isFallback: true,
  }
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
        }
        default:
          formulaBase = basePrice
      }

      let price = formulaBase * (1 - (item.priceDiscount ?? 0) / 100)
      price += item.priceSurcharge ?? 0
      if (item.priceMinMargin !== undefined) {
        const cost = product.standardPrice ?? 0
        price = Math.max(price, cost + item.priceMinMargin)
      }
      if (item.priceMaxMargin !== undefined) {
        const cost = product.standardPrice ?? 0
        price = Math.min(price, cost + item.priceMaxMargin)
      }
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
      return `${scope}：固定价 €${item.fixedPrice}${qty}`
    case 'percentage':
      return `${scope}：折扣 ${item.percentDiscount}%${qty}`
    case 'formula': {
      const base =
        item.formulaBase === 'standard_price' ? '进价' :
        item.formulaBase === 'pricelist' ? `价格表 ${item.basedOnPricelistId}` : '牌价'
      const disc = item.priceDiscount ? `，再 -${item.priceDiscount}%` : ''
      const surcharge = item.priceSurcharge ? `，+€${item.priceSurcharge}` : ''
      return `${scope}：基于${base}${disc}${surcharge}${qty}`
    }
    default:
      return scope
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
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
 *      - 'multi'   → 走关联价格表引擎
 *      - 'default' → 直接返回 product.listPrice（忽略价格表）
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
        itemDesc: `专属固定价 €${sp.fixedPrice}${sp.minQty > 0 ? `，最小数量 ${sp.minQty}` : ''}${noteStr}`,
        isFallback: false,
        isSpecialPrice: true,
      }
    }
  }

  // ── 第二优先级：按 priceType 分支 ─────────────────────────────────────────

  // default：直接用商品牌价，完全忽略价格表
  if (priceType === 'default') {
    return {
      price: round2(basePrice),
      pricelistName: '直接牌价',
      itemDesc: '客户定价模式：直接牌价（忽略价格表）',
      isFallback: true,
    }
  }

  // last：用该客户最近一笔成交价
  if (priceType === 'last') {
    if (lastPrice !== undefined && lastPrice > 0) {
      return {
        price: round2(lastPrice),
        pricelistName: '最近成交价',
        itemDesc: `最近一次售价 €${lastPrice.toFixed(2)}`,
        isFallback: false,
      }
    }
    // 若查不到历史成交价，回退牌价
    return {
      price: round2(basePrice),
      pricelistName: '最近成交价（无历史，回退牌价）',
      itemDesc: '该客户从未购买此商品，回退到牌价',
      isFallback: true,
    }
  }

  // multi（默认）：客户价格表规则 → lastPrice → listPrice
  // Step 1: 尝试价格表规则
  let priceResolution: PriceResolution | null = null

  if (customer.pricelistId) {
    const pl = allPricelists.find(p => p.id === customer.pricelistId)
    if (pl) {
      priceResolution = resolvePrice(product, pl, allPricelists, qty)
      if (!priceResolution.isFallback) {
        return priceResolution  // 命中规则，直接返回
      }
    }
  }

  // Step 2: 价格表未命中 → 尝试最近成交价
  if (lastPrice !== undefined && lastPrice > 0) {
    const fromDesc = priceResolution
      ? `${priceResolution.pricelistName}（规则未命中）`
      : customer.pricelistId
        ? '价格表不存在'
        : '无价格表'
    return {
      price: round2(lastPrice),
      pricelistName: '最近成交价',
      itemDesc: `${fromDesc}，改用最近售价 €${lastPrice.toFixed(2)}`,
      isFallback: false,
    }
  }

  // Step 3: 无历史成交价 → 回退牌价
  if (priceResolution) return priceResolution  // isFallback=true，已含 listPrice

  return {
    price: round2(basePrice),
    pricelistName: '牌价',
    itemDesc: customer.pricelistId
      ? '价格表不存在，使用牌价'
      : '客户未关联价格表，使用牌价',
    isFallback: true,
  }
}
