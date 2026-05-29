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
  quantity: number
  authoritativeUnitPrice: number  // 服务端计算出的权威单价
  submittedUnitPrice: number       // 前端提交的单价
  accepted: boolean                // 是否落库采用前端价格（默认以 authoritative 为准）
  subtotal: number                 // = authoritativeUnitPrice * quantity
  resolution: PriceResolution       // 价格溯源（来自哪条规则）
  uomId?: string
  uomName?: string
  taxRate?: number
}

export interface PricingContext {
  prisma: Pick<PrismaClient,
    'user' | 'customer' | 'product' | 'productTemplate' | 'odooPricelist' | 'order'>
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
    include: { specialPrices: true },
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
    pricelistId: raw.pricelistId ?? undefined,
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
 * 批量查询某客户对一组商品的最近一次成交价。
 * 用于前端 place-order 页一次性拉所有 line 的 lastPrice，避免 N 次往返。
 *
 * 实现策略：扫该客户最近 200 条订单的 items JSON，对每个 productId 取**首个命中**
 * （订单按 createdAt desc 排序，因此首个命中即最近一次）。
 *
 * @returns Record<productId, number>。未命中的 productId 不在结果里（前端按缺省判断 = 无历史）
 */
export async function queryLastSoldPrices(
  prisma: PricingContext['prisma'],
  customerId: string,
  productIds: string[],
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  if (productIds.length === 0) return result

  const users = await prisma.user.findMany({
    where: { customerId },
    select: { id: true },
  })
  const restaurantIds = users.map((u) => u.id)
  if (restaurantIds.length === 0) return result

  const wanted = new Set(productIds)
  const recent = await prisma.order.findMany({
    where: { restaurantId: { in: restaurantIds } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { items: true },
  })

  for (const order of recent) {
    if (wanted.size === 0) break
    const items = order.items as Array<{ productId: string; price: number }>
    for (const it of items) {
      if (!wanted.has(it.productId)) continue
      if (!Number.isFinite(it.price) || it.price <= 0) continue
      result[it.productId] = it.price
      wanted.delete(it.productId)
    }
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
    price?: number        // 前端传入的参考价格
    quantity: number
    uomId?: string
    uomName?: string
    taxRate?: number
  }>,
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
      stock: toNumOpt(dbProduct.stock),
      status: (dbProduct.status?.toLowerCase() as ProductType['status']) ?? 'active',
      createdAt: dbProduct.createdAt.toISOString(),
      updatedAt: dbProduct.updatedAt.toISOString(),
      externalId: dbProduct.externalId ?? undefined,
      sequence: dbProduct.sequence ?? undefined,
    }

    // priceType='last' 或 'multi' 时均需查历史成交价：
    //   last  → 直接作为定价结果（无则回退牌价）
    //   multi → 价格表规则 → lastPrice → listPrice（三级优先级）
    const normalizedPriceType = (customer.priceType ?? 'multi').toLowerCase()
    let lastPrice: number | undefined
    if (normalizedPriceType === 'last' || normalizedPriceType === 'multi') {
      lastPrice = await queryLastSoldPrice(ctx.prisma, customer.id, item.productId)
    }

    const resolution = resolveCustomerPrice(
      productForEngine,
      customer,
      allPricelists,
      qty,
      lastPrice,
    )

    const submittedUnit = Number(item.price ?? 0)
    const authoritative = Number(resolution.price)
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
      quantity: qty,
      authoritativeUnitPrice: authoritative,
      submittedUnitPrice: submittedUnit,
      accepted,
      subtotal,
      resolution,
      uomId: item.uomId,
      uomName: item.uomName,
      taxRate: item.taxRate,
    })
  }

  return {
    lines,
    totalAmount: Math.round(total * 100) / 100,
    customer,
    pricelistId: customer.pricelistId ?? null,
    priceType: customer.priceType ?? null,
    warnings,
  }
}

/** 把 ResolvedLine 压扁成入库用的 OrderItem（旧 JSON 结构兼容） */
export function toOrderItems(lines: ResolvedLine[]): OrderItem[] {
  return lines.map((l) => ({
    productId: l.productId,
    productName: l.productName,
    spec: l.spec,
    price: l.authoritativeUnitPrice,
    quantity: l.quantity,
    subtotal: l.subtotal,
  }))
}
