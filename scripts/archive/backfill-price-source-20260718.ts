/**
 * scripts/backfill-price-source-20260718.ts
 * 反推回填历史订单行（含 Odoo 导入）的 priceSourceType/Detail/Date。
 *
 * 背景：priceSourceType 三字段 2026-07-18 才随 commit 1184606 上线，只在下单/编辑保存那一刻
 * 计算并落库，历史订单行全部为 null（全库 1,337,541 行验证结果：0 行有值）。这里对已有
 * 历史行做尽力反推，用当时的订单日期 + 商品当前定价配置去匹配，只是近似还原，不是精确重放。
 *
 * 反推优先级（与线上定价引擎 lib/pricing-engine.ts 的 SPECIAL > PRICELIST > LAST > DEFAULT 口径一致）：
 *   1. SPECIAL   命中客户专属价（当前全库 CustomerSpecialPrice=0 条，代码留着但预期不会命中）
 *   2. PRICELIST 用订单历史配送日(deliveryDate ?? createdAt)对客户当前挂的价格表链跑
 *                resolvePrice()，算出来的价格跟历史 unitPrice 对得上（容差 €0.01）
 *   3. LAST      同客户同商品，价格与"时间上更早一笔"订单的 unitPrice 一致 —— 基于真实历史
 *                订单序列，不是猜的
 *   4. DEFAULT   跟商品当前牌价（listPrice/price）对得上
 *   5. 以上都对不上 → 兜底标 PRICELIST，不带具体价格表名（客户要求：没有就用 pricelist 兜底）
 *
 * 只处理 priceSourceType 为 null 的行，不覆盖已有值（迁移是幂等的，可重复运行补漏）。
 *
 * 运行：
 *   npx tsx --env-file=.env.local scripts/backfill-price-source-20260718.ts            # dry-run，只统计不写
 *   npx tsx --env-file=.env.local scripts/backfill-price-source-20260718.ts --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import { PrismaClient, Prisma } from '../lib/generated/prisma/client'
import { resolvePrice } from '../lib/pricing-engine'
import type { Product as ProductType, OdooPricelist as OdooPricelistType, Customer as CustomerType } from '../lib/types'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const TOLERANCE = 0.01
const LINE_BATCH = 20_000
const WRITE_BATCH = 1_000

type SourceType = 'SPECIAL' | 'PRICELIST' | 'LAST' | 'DEFAULT'

interface LineRec {
  id: string
  orderId: string
  productId: string
  unitPrice: number
  qty: number
}

interface OrderRec {
  customerId: string
  dateStr: string // YYYY-MM-DD，用于 pricelist item 的 dateStart/dateEnd 过滤
  ts: number // 排序用的时间戳（LAST 反推按真实先后顺序）
}

interface Classified {
  id: string
  type: SourceType
  detail: string | null
  date: Date | null
}

function toNum(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function toNumOpt(v: unknown): number | undefined {
  return v == null ? undefined : Number(v)
}

async function main() {
  console.log(APPLY ? '=== APPLY 模式：会实际写入数据库 ===' : '=== DRY-RUN 模式：只统计不写库（加 --apply 才会写）===')

  // ── 1. 预载参考数据 ──────────────────────────────────────────────────────
  console.log('加载客户/商品/价格表...')

  const customersDb = await prisma.customer.findMany({
    select: {
      id: true,
      priceType: true,
      pricelists: { select: { pricelistId: true, sequence: true }, orderBy: { sequence: 'asc' } },
      specialPrices: { select: { productId: true, minQty: true, fixedPrice: true, dateStart: true, dateEnd: true, note: true } },
    },
  })
  const customerMap = new Map<string, CustomerType>()
  for (const c of customersDb) {
    customerMap.set(c.id, {
      id: c.id,
      name: '', address: null, phone: null, email: null, vatNumber: null,
      paymentTerm: null as unknown as CustomerType['paymentTerm'],
      createdAt: '', isActive: true,
      priceType: (c.priceType as CustomerType['priceType']) ?? 'multi',
      pricelists: c.pricelists.map(p => ({ pricelistId: p.pricelistId, sequence: p.sequence })),
      specialPrices: c.specialPrices.map(sp => ({
        id: '', productId: sp.productId, minQty: toNum(sp.minQty), fixedPrice: toNum(sp.fixedPrice),
        dateStart: sp.dateStart ?? undefined, dateEnd: sp.dateEnd ?? undefined, note: sp.note ?? undefined,
      })),
    } as unknown as CustomerType)
  }

  const users = await prisma.user.findMany({ where: { customerId: { not: null } }, select: { id: true, customerId: true } })
  const userToCustomer = new Map(users.map(u => [u.id, u.customerId as string]))

  const productsDb = await prisma.product.findMany({ include: { template: true } })
  const productEngineMap = new Map<string, ProductType>()
  for (const p of productsDb) {
    productEngineMap.set(p.id, {
      id: p.id, templateId: p.templateId, name: p.name,
      variantAttributes: (p.variantAttributes as unknown as ProductType['variantAttributes']) ?? [],
      internalRef: p.internalRef ?? undefined,
      listPrice: toNum(p.listPrice ?? p.template.listPrice ?? p.price ?? 0),
      standardPrice: toNum(p.standardPrice ?? p.template.standardPrice ?? 0),
      qtyOnHand: toNum(p.qtyOnHand), active: p.active,
      categoryId: p.categoryId ?? p.template.categoryId ?? undefined,
      customerTaxRate: toNumOpt(p.customerTaxRate ?? p.template.customerTaxRate),
      commissionPrice: toNumOpt(p.commissionPrice ?? p.template.commissionPrice),
      images: p.images, spec: p.spec ?? undefined, price: toNumOpt(p.price), stock: toNumOpt(p.qtyOnHand),
      status: (p.status?.toLowerCase() as ProductType['status']) ?? 'active',
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
      externalId: p.externalId ?? undefined, sequence: p.sequence ?? undefined,
    } as ProductType)
  }

  const pricelistsDb = await prisma.odooPricelist.findMany()
  const allPricelists: OdooPricelistType[] = pricelistsDb.map(p => ({
    id: p.id, externalId: p.externalId ?? undefined, name: p.name, currency: p.currency,
    items: (p.items as unknown as OdooPricelistType['items']) ?? [],
    sequence: p.sequence, selectable: p.selectable, active: p.active, updatedAt: p.updatedAt.toISOString(),
  }))
  const pricelistById = new Map(allPricelists.map(p => [p.id, p]))

  console.log(`  客户 ${customerMap.size}，商品 ${productEngineMap.size}，价格表 ${allPricelists.length}`)

  // ── 2. 预载全部订单 → 解析出 customerId + 历史日期 ────────────────────────
  console.log('加载订单...')
  const ordersDb = await prisma.order.findMany({
    select: { id: true, restaurantId: true, deliveryDate: true, createdAt: true },
  })
  const orderMap = new Map<string, OrderRec>()
  for (const o of ordersDb) {
    const customerId = userToCustomer.get(o.restaurantId) ?? o.restaurantId
    const d = o.deliveryDate ?? o.createdAt
    orderMap.set(o.id, { customerId, dateStr: d.toISOString().slice(0, 10), ts: d.getTime() })
  }
  console.log(`  订单 ${orderMap.size}`)

  // ── 3. 分批拉取待回填订单行（priceSourceType 为 null）──────────────────────
  console.log('加载待回填订单行...')
  const lines: LineRec[] = []
  let cursor: string | undefined
  for (;;) {
    const batch = await prisma.orderLine.findMany({
      where: { priceSourceType: null },
      orderBy: { id: 'asc' },
      take: LINE_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, orderId: true, productId: true, unitPrice: true, orderedQty: true },
    })
    if (batch.length === 0) break
    for (const l of batch) {
      lines.push({ id: l.id, orderId: l.orderId, productId: l.productId, unitPrice: toNum(l.unitPrice), qty: toNum(l.orderedQty) })
    }
    cursor = batch[batch.length - 1].id
    if (batch.length < LINE_BATCH) break
  }
  console.log(`  待回填订单行 ${lines.length}`)

  // ── 4. 按 customerId::productId 分组，按历史时间排序，标出 LAST 命中 ────────
  console.log('构建 LAST 反推序列...')
  const groups = new Map<string, number[]>()
  for (let i = 0; i < lines.length; i++) {
    const order = orderMap.get(lines[i].orderId)
    if (!order) continue
    const key = `${order.customerId}::${lines[i].productId}`
    let arr = groups.get(key)
    if (!arr) { arr = []; groups.set(key, arr) }
    arr.push(i)
  }
  const lastMatchDate = new Map<number, Date>() // line index → 命中的更早那笔订单日期
  for (const idxArr of groups.values()) {
    idxArr.sort((a, b) => {
      const oa = orderMap.get(lines[a].orderId)!
      const ob = orderMap.get(lines[b].orderId)!
      return oa.ts - ob.ts
    })
    for (let k = 1; k < idxArr.length; k++) {
      const cur = idxArr[k]
      const prev = idxArr[k - 1]
      if (Math.abs(lines[cur].unitPrice - lines[prev].unitPrice) <= TOLERANCE) {
        const prevOrder = orderMap.get(lines[prev].orderId)!
        lastMatchDate.set(cur, new Date(prevOrder.ts))
      }
    }
  }
  console.log(`  LAST 候选命中 ${lastMatchDate.size} 行`)

  // ── 5. 逐行分类 ────────────────────────────────────────────────────────
  console.log('分类中...')
  const results: Classified[] = []
  const stats: Record<SourceType, number> = { SPECIAL: 0, PRICELIST: 0, LAST: 0, DEFAULT: 0 }
  let fallbackCount = 0
  let skippedNoOrder = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const order = orderMap.get(line.orderId)
    if (!order) { skippedNoOrder++; continue }

    const customer = customerMap.get(order.customerId)
    const product = productEngineMap.get(line.productId)

    // 1) SPECIAL
    let matched: Classified | null = null
    if (customer?.specialPrices?.length) {
      const hit = customer.specialPrices
        .filter(sp => sp.productId === line.productId
          && line.qty >= sp.minQty
          && (!sp.dateStart || order.dateStr >= sp.dateStart)
          && (!sp.dateEnd || order.dateStr <= sp.dateEnd)
          && Math.abs(sp.fixedPrice - line.unitPrice) <= TOLERANCE)
        .sort((a, b) => b.minQty - a.minQty)[0]
      if (hit) matched = { id: line.id, type: 'SPECIAL', detail: hit.note ?? null, date: null }
    }

    // 2) PRICELIST — 用历史日期对客户当前挂的价格表链跑
    if (!matched && customer && product) {
      const orderedIds = (customer.pricelists ?? []).slice().sort((a, b) => a.sequence - b.sequence).map(l => l.pricelistId)
      for (const plId of orderedIds) {
        const pl = pricelistById.get(plId)
        if (!pl) continue
        const r = resolvePrice(product, pl, allPricelists, line.qty, order.dateStr)
        if (!r.isFallback && Math.abs(r.price - line.unitPrice) <= TOLERANCE) {
          matched = { id: line.id, type: 'PRICELIST', detail: pl.name, date: null }
          break
        }
      }
    }

    // 3) LAST
    if (!matched && lastMatchDate.has(i)) {
      matched = { id: line.id, type: 'LAST', detail: null, date: lastMatchDate.get(i)! }
    }

    // 4) DEFAULT
    if (!matched && product) {
      const basePrice = product.listPrice ?? product.price ?? 0
      if (Math.abs(basePrice - line.unitPrice) <= TOLERANCE) {
        matched = { id: line.id, type: 'DEFAULT', detail: null, date: null }
      }
    }

    // 5) 兜底：都对不上，标 PRICELIST（客户要求）
    if (!matched) {
      matched = { id: line.id, type: 'PRICELIST', detail: null, date: null }
      fallbackCount++
    }

    stats[matched.type]++
    results.push(matched)
  }

  console.log('\n=== 分类统计 ===')
  console.log(`  SPECIAL:   ${stats.SPECIAL}`)
  console.log(`  PRICELIST: ${stats.PRICELIST} (其中兜底/未匹配到具体条目 ${fallbackCount})`)
  console.log(`  LAST:      ${stats.LAST}`)
  console.log(`  DEFAULT:   ${stats.DEFAULT}`)
  console.log(`  跳过(找不到订单): ${skippedNoOrder}`)
  console.log(`  合计: ${results.length}`)

  console.log('\n=== 抽样(每类前 3 条) ===')
  for (const t of ['SPECIAL', 'PRICELIST', 'LAST', 'DEFAULT'] as SourceType[]) {
    const sample = results.filter(r => r.type === t).slice(0, 3)
    for (const s of sample) console.log(`  [${t}] line=${s.id} detail=${s.detail ?? '-'} date=${s.date?.toISOString() ?? '-'}`)
  }

  if (!APPLY) {
    console.log('\ndry-run 结束，未写入数据库。确认统计结果后加 --apply 执行实际写入。')
    return
  }

  // ── 6. 批量写入（原生 SQL，UPDATE ... FROM VALUES）───────────────────────
  console.log(`\n开始写入，共 ${results.length} 行，每批 ${WRITE_BATCH}...`)
  let written = 0
  for (let i = 0; i < results.length; i += WRITE_BATCH) {
    const batch = results.slice(i, i + WRITE_BATCH)
    const rows = batch.map(r => Prisma.sql`(${r.id}::text, ${r.type}::text, ${r.detail}::text, ${r.date}::timestamp)`)
    await prisma.$executeRaw`
      UPDATE "OrderLine" AS ol
      SET "priceSourceType" = v.type, "priceSourceDetail" = v.detail, "priceSourceDate" = v.date
      FROM (VALUES ${Prisma.join(rows)}) AS v(id, type, detail, date)
      WHERE ol.id = v.id AND ol."priceSourceType" IS NULL
    `
    written += batch.length
    if (written % 50_000 < WRITE_BATCH) console.log(`  已写入 ${written}/${results.length}`)
  }
  console.log(`写入完成，共 ${written} 行。`)
}

main().finally(() => prisma.$disconnect())
