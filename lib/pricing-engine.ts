/**
 * Odoo Pricelist 定价引擎（完整复刻）
 *
 * 优先级：
 *   1. 按"适用目标"（targetKeyOf：applyOn+productId/categoryId+uomId）分组
 *   2. 组间：取各组最小 sequence 排序，最小的那组生效——不同目标（variant/product/
 *      category/global）之间谁优先完全由 sequence 决定，不隐含"谁更具体谁优先"
 *   3. 组内（同一目标下的多条 minQty 阶梯规则）：自动挑"仍满足 qty>=minQty 的最大
 *      minQty"那一档，minQty 相同才退回 sequence/数组顺序裁决（20261026 改动，
 *      之前组内也是纯 sequence 优先，新建条目默认 sequence 都是 10 时极易排错导致
 *      阶梯价形同虚设）
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
  /** 20260823：命中的是单位限定规则（`item.uomId` 有值且匹配调用方传入的 uomId）时，
   *  这里回填该 uomId —— 调用方据此知道 `price` 已经是这个单位的最终价，
   *  不能再乘 `ProductSaleUom.factor` 二次换算（否则界面填的数字和实际生效的对不上）。 */
  matchedUomId?: string
  /** 20260926：命中的条目配了 `badgeLabel` 时回填，客户门户拿去渲染促销角标文案 */
  promoLabel?: string
  /** 20260926：命中促销条目时的折前基准价，配合 promoLabel 在门户画划线原价；未命中促销时不填 */
  originalPrice?: number
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
 * @param uomId         调用方本行选用的可售单位；只用于匹配单位限定规则（`item.uomId`），
 *                       不传 = 与改造前行为一致，单位限定规则一律不命中，回退到通用规则
 * @param _depth        内部递归深度计数器，外部不要传
 */
export function resolvePrice(
  product: Product,
  pricelist: OdooPricelist,
  allPricelists: OdooPricelist[],
  qty = 1,
  date?: string,
  uomId?: string,
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

  // 20261026：候选条目先按"适用目标"（targetKeyOf）分组——同一个目标下的多条 minQty
  // 阶梯规则，不再要求运营手工把 sequence 从大到小精确排成"minQty 越大 sequence 越小"
  // 才能生效（新建条目默认 sequence 全是 10，极易排错，导致阶梯价形同虚设，见
  // docs/*pricelist-sequence* 相关记录）。组内改为照抄 CustomerSpecialPrice 的做法，
  // 自动挑"仍满足 qty>=minQty 的最大 minQty"那一档；minQty 相同时才用 sequence/数组
  // 顺序裁决（tests/pricing-engine-priority.test.ts 锁死的行为）。
  // 不同目标（variant/product/category/global）之间的优先级则继续完全由 sequence 决定
  // （用该目标下最小的 sequence 代表这一组在列表里的位置），不隐含"谁更具体谁优先"，
  // 跟改动前的语义保持一致。
  const candidates = pricelist.items.filter(item => {
    if (item.dateStart && today < item.dateStart) return false
    if (item.dateEnd && today > item.dateEnd) return false
    if (!matchesItem(item, product, uomId)) return false
    // 防止嵌套递归超过深度限制：当已接近深度限制时，跳过引用其他价格表的项
    if (_depth >= 5 && item.computeType === 'formula' && item.formulaBase === 'pricelist') return false
    return true
  })

  const groups = new Map<string, OdooPricelistItem[]>()
  for (const item of candidates) {
    const key = targetKeyOf(item)
    const arr = groups.get(key)
    if (arr) arr.push(item)
    else groups.set(key, [item])
  }

  let winner: { item: OdooPricelistItem; computed: number; groupSequence: number } | undefined
  for (const groupItems of groups.values()) {
    const groupSequence = Math.min(...groupItems.map(i => i.sequence))
    const eligible = groupItems
      .filter(i => qty >= i.minQty)
      .sort((a, b) => b.minQty - a.minQty || a.sequence - b.sequence)

    for (const candidate of eligible) {
      const computed = computeItemPrice(candidate, product, basePrice, allPricelists, qty, date, _depth, uomId)
      if (computed === null) continue
      if (!winner || groupSequence < winner.groupSequence) {
        winner = { item: candidate, computed, groupSequence }
      }
      break // 组内第一个算得出价的候选（已按 minQty 降序排好）即为这一组的代表
    }
  }

  if (winner) {
    const roundedComputed = round2(winner.computed)
    // 20260926（code-review 发现）：badgeLabel 只代表"这条规则想营销"，不代表算出来的价真的比牌价低——
    // formula 类规则可能因为 priceMinMargin 夹取反而比牌价贵。角标+划线原价只在真降价时才展示，
    // 否则客户会看到一个"划线原价比现价还低"的诡异促销角标。
    const isRealDiscount = winner.item.badgeLabel && roundedComputed < round2(basePrice)

    return {
      price: roundedComputed,
      pricelistName: pricelist.name,
      itemDesc: describeItem(winner.item),
      isFallback: false,
      sourceType: 'pricelist',
      matchedUomId: winner.item.uomId,
      ...(isRealDiscount ? { promoLabel: winner.item.badgeLabel, originalPrice: round2(basePrice) } : {}),
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
  uomId?: string,
): PriceResolution | null {
  for (const plId of orderedPricelistIds) {
    const pl = allPricelists.find(p => p.id === plId)
    if (!pl) continue
    const r = resolvePrice(product, pl, allPricelists, qty, undefined, uomId)
    if (!r.isFallback) return r
  }
  return null
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

/**
 * 判断 item 是否匹配商品变体（含可选单位过滤）
 *
 * `item.uomId` 有值 = 这条规则限定了某个可售单位，只有调用方传入的 `uomId` 与它相等才命中；
 * 不填 `item.uomId`（存量数据 / 不限定的规则）= 对该商品所有可售单位都生效，不受 `uomId` 影响。
 */
function matchesItem(item: OdooPricelistItem, product: Product, uomId?: string): boolean {
  // 20261017：标记为不可售的规则直接跳过，继续往下一条规则/回退牌价找——
  // 季节性/运输原因暂停这条规则按表价卖，不是把它从表里删掉。
  if (item.selectable === false) return false
  if (item.uomId && item.uomId !== uomId) return false
  switch (item.applyOn) {
    case 'global':
      return true
    case 'product':
      // 20260825 合表重构：ProductTemplate 已删，'product' 与 'variant' 两级现在
      // 语义完全等价，都是锁定到 product.id（价格表选择器计划合并为一层，见 T8）。
      // productTemplateId 字段名保留，值已在数据迁移时 remap 成 Product.id。
      return item.productTemplateId !== undefined && item.productTemplateId === product.id
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
 * 条目的"适用目标"标识：同一目标下的多条 minQty 阶梯规则属于同一组，由 resolvePrice
 * 自动按 minQty 挑最合适档位；不同目标之间仍由 sequence 决定优先级，不在这里混在一起。
 * 带 `item.uomId` 的单位限定规则单独成组，不与不限定单位的通用规则合并阶梯。
 */
function targetKeyOf(item: OdooPricelistItem): string {
  const uomPart = item.uomId ?? ''
  switch (item.applyOn) {
    case 'product':
      return `product:${item.productTemplateId}:${uomPart}`
    case 'variant':
      return `variant:${item.productVariantId}:${uomPart}`
    case 'category':
      return `category:${item.categoryId}:${uomPart}`
    case 'global':
    default:
      return `global:${uomPart}`
  }
}

/**
 * 根据条目计算价格
 * 返回 null 表示无法计算（如 pricelist formulaBase 但找不到目标表）
 *
 * 导出给价格表管理页用：formula 模式的条目只展示"X% discount and Y surcharge"公式
 * 文字，看不出实际卖多少钱，运营得自己拿 Cost/Public Price 手算。必须复用这同一份
 * 计算逻辑，不能在页面上照公式另抄一份——否则会重蹈 scaleAuthoritativePrice 那种
 * "两份实现算出两个数字"的覆辙（20260826）。
 */
/** item.uomId 限定的规则，折扣/加价的基准必须是该单位自己的价（factor 换算），不是商品基准单位的价 */
function getSaleUomFactor(product: Product, uomId: string): number {
  const row = product.saleUoms?.find(s => s.uomId === uomId)
  const factor = row ? Number(row.factor) : 1
  return factor > 0 ? factor : 1
}

export function computeItemPrice(
  item: OdooPricelistItem,
  product: Product,
  basePrice: number,
  allPricelists: OdooPricelist[],
  qty: number,
  date: string | undefined,
  depth: number,
  uomId?: string,
): number | null {
  // 20261025：命中 uomId 限定规则时，basePrice/formulaBase 传进来的一直是商品基准单位
  // （比如一箱）的价格，折扣/加价却要按 Sellable Unit（比如一箱 4 包里的 1 包）来算，
  // 漏了按 ProductSaleUom.factor 换算这一步，导致算出来的价格偏大了 factor 倍
  // （40.50 = 整箱价 30.5 + 10，而不是单包价 9.5 + 10 = 19.50）。
  const uomFactor = item.uomId ? getSaleUomFactor(product, item.uomId) : 1

  switch (item.computeType) {
    case 'fixed':
      return item.fixedPrice ?? null

    case 'percentage': {
      const discount = item.percentDiscount ?? 0
      return basePrice * uomFactor * (1 - discount / 100)
    }

    case 'formula': {
      let formulaBase: number
      // 嵌套 pricelist 如果已经命中了同一个 uomId 限定规则，拿到的已经是该单位的最终价，
      // 不能再乘一次 uomFactor（对应 matchedUomId 那条"不能二次换算"的约定）。
      let alreadyScaled = false
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
          const nestedResult = resolvePrice(product, nested, allPricelists, qty, date, uomId, depth + 1)
          if (nestedResult.isFallback) return null  // If nested call fell back, we should too
          formulaBase = nestedResult.price
          alreadyScaled = nestedResult.matchedUomId === item.uomId
          break
        }
        default:
          formulaBase = basePrice
      }

      if (!alreadyScaled) formulaBase *= uomFactor

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
 * @param uomId      本行选用的可售单位；用于匹配价格表条目的单位限定规则（决策见 lib/types.ts
 *                   OdooPricelistItem.uomId 注释）。不传 = 与改造前行为一致。
 */
export function resolveCustomerPrice(
  product: Product,
  customer: Customer,
  allPricelists: OdooPricelist[],
  qty = 1,
  lastPrice?: number,
  uomId?: string,
  /**
   * 20260827：`lastPrice` 是否已经精确匹配 `uomId` 这个单位本身的历史成交价
   * （调用方按 uomId 查出来的，不是跨单位或按基准单位查到后准备再换算的）。
   * 为 true 时把 `matchedUomId` 回填成 `uomId`，下游（scaleAuthoritativePrice /
   * 前端 priceOf）据此知道这个价已经是目标单位的最终价，不能再乘 factor 二次换算——
   * 否则会把"1KG 历史价"当成"基准单位(如 CASE)历史价"再折算一次，越算越离谱
   * （客户 20260827 反馈价格低于成本，见 docs 排查记录）。
   * 不传 = 与改造前行为一致：lastPrice 视为基准单位价，交给下游按 factor 换算。
   */
  lastPriceMatchedUom = false,
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
    const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty, uomId)
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
        matchedUomId: lastPriceMatchedUom ? uomId : undefined,
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
  const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty, uomId)
  if (viaChain) return viaChain

  if (lastPrice !== undefined && lastPrice > 0) {
    const fromDesc = orderedPricelistIds.length > 0 ? '价格表链未命中' : '无价格表'
    return {
      price: round2(lastPrice),
      pricelistName: '最近成交价',
      itemDesc: `${fromDesc}，改用最近售价 €${fmtMoney(lastPrice)}`,
      isFallback: false,
      sourceType: 'last',
      matchedUomId: lastPriceMatchedUom ? uomId : undefined,
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
