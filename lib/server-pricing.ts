/**
 * 服务端定价 & 价格校验
 * =====================================================================
 * 业务目的：
 *   - 下单 / 开票时，由后端权威地计算每一行应收单价（price_unit）
 *   - 前端传上来的 price 只能作为"参考值"，与权威价格误差 > 容差直接拒绝
 *   - 不再信任前端传入金额，杜绝"客户改价"漏洞
 *
 * 与浏览器端 pricing-engine 的关系：
 *   - 复用同一套 resolveCustomerPrice / resolvePrice 纯函数
 *   - 本模块负责：从数据库拉数据组装入参、记 last-price、批量计算订单行
 *
 * 使用方：POST /api/orders, POST /api/invoices, GET /api/orders/pricing-preview
 */

import type { PrismaClient } from './generated/prisma/client'
import type {
  Customer as CustomerType,
  OdooPricelist as OdooPricelistType,
  Product as ProductType,
  OrderItem,
} from './types'
import { resolveCustomerPrice, type PriceResolution } from './pricing-engine'
import { toNum, toNumOpt } from './decimal-helpers'

// ─── 价格校验容差 ─────────────────────────────────────────────────────────────
//
// 允许前端传入的价格与权威价格有 1 分钱（€0.01）误差，用于吸收浮点误差。
// 超过容差直接拒绝，不允许前端任意改价。
export const PRICE_TOLERANCE_EUR = 0.01

export interface ResolvedLine {
  productId: string
  productName: string
  spec: string
  note?: string
  quantity: number
  authoritativeUnitPrice: number  // 服务端计算出的权威单价
  submittedUnitPrice: number       // 前端提交的单价
  accepted: boolean                // 是否落库采用前端价格（默认以 authoritative 为准）
  subtotal: number                 // = authoritativeUnitPrice * quantity
  resolution: PriceResolution       // 价格溯源（来自哪条规则）
  /** resolution.sourceType==='last' 时，那笔最近成交发生的时间；其余情况为 undefined */
  lastPriceDate?: Date
  uomId?: string
  uomName?: string
  taxRate?: number
}

export interface PricingContext {
  prisma: Pick<PrismaClient,
    'user' | 'customer' | 'product' | 'productTemplate' | 'odooPricelist' | 'order' | 'orderLine' | 'productSaleUom' | 'uom'>
  /**
   * 前端传入的 restaurantId 可能是 User.id（老流程）或 Customer.id（新流程）。
   * 统一在这里解析成 Customer 记录，不存在则报错。
   */
  restaurantId: string
  /** 日期，用于 pricelist item 的 date_start/date_end 过滤 */
  today?: string
}

/** 从 restaurantId 解析出 Customer 记录 + 挂载 specialPrices */
export async function loadCustomerFromRestaurantId(
  prisma: PricingContext['prisma'],
  restaurantId: string,
): Promise<CustomerType | null> {
  // 情形 A：restaurantId 是 User.id（餐馆用户）
  const user = await prisma.user.findFirst({
    where: { id: restaurantId },
    select: { customerId: true },
  })
  const customerId = user?.customerId ?? restaurantId
  if (!customerId) return null
  const raw = await prisma.customer.findFirst({
    where: { id: customerId },
    include: {
      specialPrices: true,
      pricelists: { orderBy: { sequence: 'asc' } },
    },
  })
  if (!raw) return null
  // Decimal → number 边界转换
  const cust: CustomerType = {
    id: raw.id,
    name: raw.name,
    address: raw.address,
    phone: raw.phone,
    email: raw.email,
    vatNumber: raw.vatNumber,
    paymentTerm: raw.paymentTerm as CustomerType['paymentTerm'],
    creditLimit: toNumOpt(raw.creditLimit),
    commissionRate: toNumOpt(raw.commissionRate),
    createdAt: raw.createdAt.toISOString(),
    isActive: raw.isActive,
    externalId: raw.externalId ?? undefined,
    city: raw.city ?? undefined,
    notes: raw.notes ?? undefined,
    pricelists: raw.pricelists.map((p) => ({ pricelistId: p.pricelistId, sequence: p.sequence })),
    priceType: (raw.priceType as CustomerType['priceType']) ?? 'multi',
    specialPrices: raw.specialPrices.map((sp) => ({
      id: sp.id,
      productId: sp.productId,
      minQty: toNum(sp.minQty),
      fixedPrice: toNum(sp.fixedPrice),
      dateStart: sp.dateStart ?? undefined,
      dateEnd: sp.dateEnd ?? undefined,
      note: sp.note ?? undefined,
    })),
  }
  return cust
}

/** 查询该客户最近一次某商品的成交价（用于 priceType='last'） */
export async function queryLastSoldPrice(
  prisma: PricingContext['prisma'],
  customerId: string,
  productId: string,
): Promise<number | undefined> {
  const map = await queryLastSoldPrices(prisma, customerId, [productId])
  return map[productId]
}

/**
 * 同 queryLastSoldPrice，额外带上那笔成交发生的时间（订单 createdAt），
 * 用于 OrderLine.priceSourceDate 快照——UI 上"最近成交价"的 hover 提示要能显示
 * 具体是哪天成交的，不只是金额。
 */
export async function queryLastSoldPriceWithDate(
  prisma: PricingContext['prisma'],
  customerId: string,
  productId: string,
): Promise<{ price: number; date: Date } | undefined> {
  const map = await queryLastSoldPricesDetailed(prisma, customerId, [productId])
  return map[productId]
}

/**
 * 批量查询某客户对一组商品的最近一次成交价。
 * 用于前端 place-order 页一次性拉所有 line 的 lastPrice，避免 N 次往返。
 *
 * @returns Record<productId, number>。未命中的 productId 不在结果里（前端按缺省判断 = 无历史）
 */
export async function queryLastSoldPrices(
  prisma: PricingContext['prisma'],
  customerId: string,
  productIds: string[],
): Promise<Record<string, number>> {
  const detailed = await queryLastSoldPricesDetailed(prisma, customerId, productIds)
  const result: Record<string, number> = {}
  for (const [productId, hit] of Object.entries(detailed)) result[productId] = hit.price
  return result
}

/**
 * 同 queryLastSoldPrices，额外带成交发生的时间（订单 createdAt），供 priceSourceDate 快照用。
 *
 * 两处历史坑（2026-07-20 修复，详见 docs/20260624-data-ownership-audit.md）：
 *   1. Order.restaurantId 有两种写法——应用内下单走 User.id（该 User.customerId 关联 Customer）；
 *      Odoo 历史导入订单 / 操作员直接给 Customer 下单时，restaurantId 就是 Customer.id 本身
 *      （全库仅 2 个 User 关联了 customerId，此前只查 User 那条链等于对几乎所有客户永远查空）。
 *   2. 原实现扫 Order.items JSON——15 万笔 Odoo 导入订单 items 恒为空数组，且订单一旦被
 *      编辑过 items 也不再跟随 OrderLine 更新，同样查不到。改为直接查 OrderLine 关系表。
 */
export async function queryLastSoldPricesDetailed(
  prisma: PricingContext['prisma'],
  customerId: string,
  productIds: string[],
): Promise<Record<string, { price: number; date: Date }>> {
  const result: Record<string, { price: number; date: Date }> = {}
  if (productIds.length === 0) return result

  const users = await prisma.user.findMany({
    where: { customerId },
    select: { id: true },
  })
  const restaurantIds = [customerId, ...users.map((u) => u.id)]

  // 单条查询取该客户全部相关订单行（按订单时间倒序），逐商品在内存里取首次命中（即最近一次）。
  // 原实现对每个 productId 单独发一次 findFirst——商品目录页一次要查上千个商品，等于上千次并发
  // 查询，把 Neon 连接池打满导致整个请求挂起（2026-07-29 排查确认）。
  const lines = await prisma.orderLine.findMany({
    where: {
      productId: { in: productIds },
      unitPrice: { gt: 0 },
      order: { restaurantId: { in: restaurantIds }, status: { not: 'CANCELLED' } },
    },
    orderBy: { order: { createdAt: 'desc' } },
    select: { productId: true, unitPrice: true, order: { select: { createdAt: true } } },
  })

  for (const line of lines) {
    if (result[line.productId]) continue
    result[line.productId] = { price: toNum(line.unitPrice), date: line.order.createdAt }
  }

  return result
}

/**
 * 批量计算一个订单 / 报价 / 发票的所有行的权威单价。
 *
 * @returns { lines, totalAmount, pricelistId, priceType } 可直接写入订单字段
 * @throws  当客户不存在 / 商品不存在 时抛出 Error
 */
export async function resolveOrderLines(
  ctx: PricingContext,
  submittedItems: Array<{
    productId: string
    productName?: string
    spec?: string
    note?: string         // 行级备注（商品级 note）
    price?: number        // 前端传入的参考价格
    quantity: number
    uomId?: string
    uomName?: string
    taxRate?: number
  }>,
  /**
   * 本单临时覆盖：操作员可在下单页选择不同于客户档案默认的价格表/定价模式。
   * 仅当字段存在时才覆盖（undefined = 沿用客户档案；null = 本单明确不用价格表）。
   */
  overrides?: { pricelistId?: string | null; priceType?: string | null },
): Promise<{
  lines: ResolvedLine[]
  totalAmount: number
  customer: CustomerType
  pricelistId: string | null
  priceType: string | null
  warnings: string[]
}> {
  const customer = await loadCustomerFromRestaurantId(ctx.prisma, ctx.restaurantId)
  if (!customer) {
    throw Object.assign(new Error(`客户不存在（restaurantId=${ctx.restaurantId}）`), { status: 400 })
  }

  // 本单覆盖：操作员可临时选一张价格表代替客户档案的整条优先级链（不写回客户档案）。
  // overrides.pricelistId === undefined → 沿用客户档案的多价格表链
  // overrides.pricelistId 是字符串        → 本单只用这一张（临时链长度为 1）
  // overrides.pricelistId === null        → 本单明确不用价格表
  const effectivePricelists: CustomerType['pricelists'] =
    overrides?.pricelistId !== undefined
      ? (overrides.pricelistId ? [{ pricelistId: overrides.pricelistId, sequence: 1 }] : [])
      : customer.pricelists
  const effectiveCustomer: CustomerType = {
    ...customer,
    pricelists: effectivePricelists,
    priceType: (overrides?.priceType ?? customer.priceType) as CustomerType['priceType'],
  }

  // 拉所有 pricelist（支持嵌套 formulaBase='pricelist'）
  const pricelistsDb = await ctx.prisma.odooPricelist.findMany()
  const allPricelists: OdooPricelistType[] = pricelistsDb.map((p) => ({
    id: p.id,
    externalId: p.externalId ?? undefined,
    name: p.name,
    currency: p.currency,
    items: (p.items as unknown as OdooPricelistType['items']) ?? [],
    sequence: p.sequence,
    selectable: p.selectable,
    active: p.active,
    updatedAt: p.updatedAt.toISOString(),
  }))

  // 拉所有涉及的商品变体 + 模板（一次性，避免 N+1）
  const productIds = [...new Set(submittedItems.map((i) => i.productId))]
  const products = await ctx.prisma.product.findMany({
    where: { id: { in: productIds } },
    include: { template: true },
  })
  const productMap = new Map(products.map((p) => [p.id, p]))

  // 多单位销售(20260714)：前端可能按非基准单位(如箱)下单，价格随之换算或走独立售价。
  // 服务端"权威定价"若不感知这一点，会把换算/独立售价一律当"客户改价"打回基准价——
  // 这里一次性批量拉 ProductSaleUom + 涉及的 Uom.factor，换算逻辑与 lib/inventory.ts
  // 的 toStockQty 同源(按 factor 比例缩放，唯一区别是这里缩放的是单价而非数量)。
  const saleUomRows = await ctx.prisma.productSaleUom.findMany({
    where: { productId: { in: productIds }, active: true },
  })
  const saleUomMap = new Map(saleUomRows.map((r) => [`${r.productId}::${r.uomId}`, r]))
  const uomIdsInvolved = [...new Set([
    ...products.map((p) => p.template.uomId).filter((x): x is string => !!x),
    ...submittedItems.map((i) => i.uomId).filter((x): x is string => !!x),
  ])]
  const uomRows = uomIdsInvolved.length > 0
    ? await ctx.prisma.uom.findMany({ where: { id: { in: uomIdsInvolved } } })
    : []
  const uomFactorMap = new Map(uomRows.map((u) => [u.id, toNum(u.factor)]))

  /** 把"基准单位"权威价换算成行选单位的权威价：优先 priceOverride，否则按 factor 比例缩放 */
  function scaleAuthoritativePrice(productId: string, anchorUomId: string | null, lineUomId: string | undefined, basePrice: number): number {
    if (!lineUomId || !anchorUomId || lineUomId === anchorUomId) return basePrice
    const saleUom = saleUomMap.get(`${productId}::${lineUomId}`)
    if (!saleUom) return basePrice
    if (saleUom.priceOverride != null) return toNum(saleUom.priceOverride)
    const lineFactor = uomFactorMap.get(lineUomId)
    const anchorFactor = uomFactorMap.get(anchorUomId)
    if (!lineFactor || !anchorFactor) return basePrice
    return basePrice * (lineFactor / anchorFactor)
  }

  const lines: ResolvedLine[] = []
  const warnings: string[] = []
  let total = 0

  for (const item of submittedItems) {
    const dbProduct = productMap.get(item.productId)
    if (!dbProduct) {
      throw Object.assign(new Error(`商品不存在：${item.productId}`), { status: 400 })
    }

    const qty = Number(item.quantity)
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) {
      throw Object.assign(new Error(`数量无效：${item.productName ?? dbProduct.name}`), { status: 400 })
    }

    // 对齐到纯 Product 类型（pricing-engine 使用）。
    // 所有 Decimal 字段在此做边界转换，变成 number。
    const productForEngine: ProductType = {
      id: dbProduct.id,
      templateId: dbProduct.templateId,
      name: dbProduct.name,
      variantAttributes: (dbProduct.variantAttributes as unknown as ProductType['variantAttributes']) ?? [],
      internalRef: dbProduct.internalRef ?? undefined,
      listPrice: toNum(dbProduct.listPrice ?? dbProduct.template.listPrice ?? dbProduct.price ?? 0),
      standardPrice: toNum(dbProduct.standardPrice ?? dbProduct.template.standardPrice ?? 0),
      qtyOnHand: toNum(dbProduct.qtyOnHand),
      active: dbProduct.active,
      categoryId: dbProduct.categoryId ?? dbProduct.template.categoryId ?? undefined,
      customerTaxRate: toNumOpt(dbProduct.customerTaxRate ?? dbProduct.template.customerTaxRate),
      commissionPrice: toNumOpt(dbProduct.commissionPrice ?? dbProduct.template.commissionPrice),
      images: dbProduct.images,
      spec: dbProduct.spec ?? undefined,
      price: toNumOpt(dbProduct.price),
      stock: toNumOpt(dbProduct.qtyOnHand),
      status: (dbProduct.status?.toLowerCase() as ProductType['status']) ?? 'active',
      createdAt: dbProduct.createdAt.toISOString(),
      updatedAt: dbProduct.updatedAt.toISOString(),
      externalId: dbProduct.externalId ?? undefined,
      sequence: dbProduct.sequence ?? undefined,
    }

    // priceType='last' 或 'multi' 时均需查历史成交价：
    //   last  → 直接作为定价结果（无则回退牌价）
    //   multi → 价格表规则 → lastPrice → listPrice（三级优先级）
    const normalizedPriceType = (effectiveCustomer.priceType ?? 'multi').toLowerCase()
    let lastPrice: number | undefined
    let lastPriceDate: Date | undefined
    if (normalizedPriceType === 'last' || normalizedPriceType === 'multi') {
      const hit = await queryLastSoldPriceWithDate(ctx.prisma, customer.id, item.productId)
      lastPrice = hit?.price
      lastPriceDate = hit?.date
    }

    const resolution = resolveCustomerPrice(
      productForEngine,
      effectiveCustomer,
      allPricelists,
      qty,
      lastPrice,
    )

    const submittedUnit = Number(item.price ?? 0)
    const authoritative = scaleAuthoritativePrice(dbProduct.id, dbProduct.template.uomId, item.uomId, Number(resolution.price))
    const accepted = Math.abs(submittedUnit - authoritative) <= PRICE_TOLERANCE_EUR

    if (!accepted && Number.isFinite(submittedUnit) && submittedUnit > 0) {
      warnings.push(
        `商品 ${productForEngine.name} 前端价格 €${submittedUnit.toFixed(2)} 与权威价 €${authoritative.toFixed(2)} 不符，已按权威价入库`,
      )
    }

    const subtotal = Math.round(authoritative * qty * 100) / 100
    total += subtotal

    lines.push({
      productId: dbProduct.id,
      productName: (item.productName ?? dbProduct.name).trim().slice(0, 200),
      spec: (item.spec ?? '').trim().slice(0, 100),
      note: item.note ? item.note.trim().slice(0, 200) : undefined,
      quantity: qty,
      authoritativeUnitPrice: authoritative,
      submittedUnitPrice: submittedUnit,
      accepted,
      subtotal,
      resolution,
      lastPriceDate: resolution.sourceType === 'last' ? lastPriceDate : undefined,
      uomId: item.uomId,
      uomName: item.uomName,
      // SSOT 护栏(A-1): OrderLine.taxRate 一律存百分数(如 23)。历史小数(0.23)与
      // 前端偶发小数在此归一;IE VAT 档位 0/4.8/9/13.5/23 在 (0,1) 无合法值,判别无歧义。
      taxRate: item.taxRate != null && item.taxRate > 0 && item.taxRate < 1 ? item.taxRate * 100 : item.taxRate,
    })
  }

  return {
    lines,
    totalAmount: Math.round(total * 100) / 100,
    customer,
    // Order.pricelistId 快照：生效链条里优先级最高的一张（跟旧行为一致——
    // 无论是否真的命中规则，都记录"当时配置/选定的价格表"，不是"最终用了哪条规则"）
    pricelistId: effectiveCustomer.pricelists?.[0]?.pricelistId ?? null,
    priceType: effectiveCustomer.priceType ?? null,
    warnings,
  }
}

/** 把 ResolvedLine 压扁成入库用的 OrderItem（旧 JSON 结构兼容） */
export function toOrderItems(lines: ResolvedLine[]): OrderItem[] {
  return lines.map((l) => ({
    productId: l.productId,
    productName: l.productName,
    spec: l.spec,
    note: l.note,
    price: l.authoritativeUnitPrice,
    quantity: l.quantity,
    subtotal: l.subtotal,
  }))
}
