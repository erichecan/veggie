/**
 * 画像派生层：读现有 Customer/Product → 确定性派生稳定画像
 * ============================================================================
 * 不重建主数据；跑在 `db:seed` 之后，从库里已有的商品/客户派生：
 *   - 商品：补全 sellPrice/cost/taxRate/uom（内存计算，不写回主数据）+ 指派供应商
 *   - 客户：层级 / 结算方式 / 业务员 / 司机归属 / 稳定常买清单 / 下单节奏
 * 同一 id 每次得到同一画像（strHash 确定性）。
 */
import type { PrismaClient } from '../../lib/generated/prisma/client'
import { Rng, strHash, stableFloat, round2 } from './rng'
import { MARK, type Ctx, type Persona, type ProductInfo, type Tier } from './context'

const SALESMEN = ['Kevin Lee', 'Sophie Wang', 'Marco Chen', 'Lucia Zhao', 'David Wu']
const SUPPLIER_NAMES = [
  '都柏林蔬菜批发', 'Green Farm Wholesale', '东方冻品厂', '南海水产',
  '华丰豆制品', '川味干货行', '本地有机农场', '亚洲食品进口',
]
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 确保有一组带标记的供应商（清理后每次重建） */
async function ensureSuppliers(prisma: PrismaClient): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < SUPPLIER_NAMES.length; i++) {
    const created = await prisma.customer.create({
      data: {
        name: SUPPLIER_NAMES[i],
        isCustomer: false,
        isVendor: true,
        externalId: MARK.vendorExternalId,
        paymentTerm: 'monthly',
        vendorTaxRate: 0,
        country: 'IE',
      },
      select: { id: true },
    })
    ids.push(created.id)
  }
  return ids
}

/** 确保有司机批次 */
async function ensureDriverSlots(
  prisma: PrismaClient,
): Promise<Array<{ id: string; driverName: string }>> {
  const existing = await prisma.driverSlot.findMany({
    where: { archived: false },
    select: { id: true, driverName: true },
  })
  if (existing.length >= 3) return existing
  const defaults = [
    { timeOfDay: 'am', batchNum: 1, driverName: 'BAO' },
    { timeOfDay: 'am', batchNum: 2, driverName: 'SEAN' },
    { timeOfDay: 'pm', batchNum: 1, driverName: 'AFZAAL' },
    { timeOfDay: 'pm', batchNum: 2, driverName: 'MING' },
  ]
  const out: Array<{ id: string; driverName: string }> = [...existing]
  for (const d of defaults) {
    if (existing.some((e) => e.driverName === d.driverName)) continue
    const created = await prisma.driverSlot.upsert({
      where: { timeOfDay_batchNum_driverName: { timeOfDay: d.timeOfDay, batchNum: d.batchNum, driverName: d.driverName } },
      update: {},
      create: d,
      select: { id: true, driverName: true },
    })
    out.push(created)
  }
  return out
}

/** 加载并补全商品信息，指派供应商 */
async function buildProducts(prisma: PrismaClient, supplierIds: string[]): Promise<ProductInfo[]> {
  const rows = await prisma.product.findMany({
    where: { active: true, status: 'ACTIVE', template: { type: 'PRODUCT', canBeSold: true } },
    select: {
      id: true,
      name: true,
      categoryId: true,
      listPrice: true,
      standardPrice: true,
      price: true,
      customerTaxRate: true,
      template: {
        select: {
          listPrice: true,
          standardPrice: true,
          customerTaxRate: true,
          uomId: true,
          uom: { select: { name: true, nameZh: true } },
        },
      },
    },
    take: 600,
  })

  const out: ProductInfo[] = []
  for (const p of rows) {
    let sell = num(p.listPrice) ?? num(p.price) ?? num(p.template?.listPrice) ?? 0
    if (sell <= 0) sell = round2(2 + (strHash(p.id) % 1800) / 100) // 2.00–19.99 兜底
    let cost = num(p.standardPrice) ?? num(p.template?.standardPrice) ?? 0
    if (cost <= 0 || cost >= sell) cost = round2(sell * (0.55 + (strHash(p.id) % 20) / 100)) // 55%–74%
    const taxRate = num(p.customerTaxRate) ?? num(p.template?.customerTaxRate) ?? 0
    out.push({
      id: p.id,
      name: p.name,
      categoryId: p.categoryId,
      uomId: p.template?.uomId ?? null,
      uomName: p.template?.uom?.nameZh ?? p.template?.uom?.name ?? null,
      sellPrice: sell,
      cost,
      taxRate,
      supplierId: supplierIds[strHash('sup:' + p.id) % supplierIds.length],
    })
  }
  return out
}

/** 为指派的供应商补建 ProductSupplierInfo（采购价≈成本） */
async function ensureSupplierInfos(prisma: PrismaClient, products: ProductInfo[]): Promise<void> {
  for (const p of products) {
    await prisma.productSupplierInfo
      .create({
        data: {
          productId: p.id,
          supplierId: p.supplierId,
          price: p.cost,
          minQty: 1,
          delay: 1 + (strHash(p.id) % 3),
          sequence: 1,
        },
      })
      .catch(() => {
        /* 已存在（uniq_product_supplier）则跳过 */
      })
  }
}

function tierOf(id: string): Tier {
  const f = stableFloat('tier:' + id)
  if (f < 0.2) return 'large'
  if (f < 0.7) return 'medium'
  return 'small'
}

function paymentTermOf(id: string, tier: Tier): Persona['paymentTerm'] {
  const f = stableFloat('pay:' + id)
  if (tier === 'large') return f < 0.85 ? 'monthly' : 'weekly'
  if (tier === 'medium') return f < 0.6 ? 'weekly' : f < 0.85 ? 'monthly' : 'cash'
  return f < 0.7 ? 'cash' : 'weekly'
}

const TIER_PARAMS: Record<Tier, { basket: [number, number]; opm: number; lpo: [number, number] }> = {
  large: { basket: [12, 20], opm: 14, lpo: [8, 12] },
  medium: { basket: [8, 12], opm: 6, lpo: [5, 8] },
  small: { basket: [4, 8], opm: 2, lpo: [3, 5] },
}

/** 主入口：组装 personas + products + suppliers + drivers 到 ctx 的部分字段 */
export async function buildPersonas(
  prisma: PrismaClient,
  limit: number,
): Promise<{
  products: ProductInfo[]
  personas: Persona[]
  supplierIds: string[]
  driverSlots: Array<{ id: string; driverName: string }>
}> {
  const supplierIds = await ensureSuppliers(prisma)
  const driverSlots = await ensureDriverSlots(prisma)
  const products = await buildProducts(prisma, supplierIds)
  if (products.length === 0) {
    throw new Error('没有可用商品（active + PRODUCT + canBeSold）。请先运行 npm run db:seed。')
  }
  await ensureSupplierInfos(prisma, products)

  const customers = await prisma.customer.findMany({
    where: { isCustomer: true, isActive: true, isVendor: false },
    select: { id: true, name: true, commissionRate: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  if (customers.length === 0) {
    throw new Error('没有可用客户。请先运行 npm run db:seed。')
  }

  const personas: Persona[] = customers.map((c) => {
    const tier = tierOf(c.id)
    const tp = TIER_PARAMS[tier]
    const localRng = new Rng(strHash('basket:' + c.id))
    const basketSize = localRng.int(tp.basket[0], tp.basket[1])
    const basket = localRng.pickN(products, Math.min(basketSize, products.length))
    const ds = driverSlots[strHash('drv:' + c.id) % driverSlots.length]
    const commissionRate =
      num(c.commissionRate) ?? [0.02, 0.03, 0.05][strHash('cm:' + c.id) % 3]
    return {
      id: c.id,
      name: c.name,
      tier,
      paymentTerm: paymentTermOf(c.id, tier),
      salesman: SALESMEN[strHash('sm:' + c.id) % SALESMEN.length],
      driverSlotId: ds?.id ?? null,
      driverName: ds?.driverName ?? null,
      commissionRate,
      basket,
      ordersPerMonth: tp.opm,
      linesPerOrder: tp.lpo,
    }
  })

  return { products, personas, supplierIds, driverSlots }
}

export type { Persona, ProductInfo, Ctx }
