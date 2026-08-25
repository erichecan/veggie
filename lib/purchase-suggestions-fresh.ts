import { prisma } from '@/lib/db'
import { toNum } from '@/lib/decimal-helpers'
import { addBusinessDays, businessTodayStart } from '@/lib/analytics/metrics'

/**
 * 生鲜冷冻品类·每日备货建议
 * ================================================================================
 * 生鲜不囤货，不看安全库存下限，只看"接下来大概要多少、手上还有多少"：
 *
 *   建议采购量 = max(0, 近3日日均出货 + 已确认未来订单 - 现有库存 - 在途采购)
 *
 * - 近3日日均出货：Order.status='COMPLETED' 且 deliveryDate 落在过去3天内的
 *   OrderLine.deliveredQty 总和 ÷ 3。deliveredQty 只在 Trip 标记 COMPLETED 时
 *   拉满（真实送达净量，含退货净额扣减），比 StockMove OUT（确认下单时的库存
 *   预留，不代表真出车）更贴近"卖出去了多少"。
 * - 已确认未来订单：status IN (CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY) 且
 *   deliveryDate >= 今天的 OrderLine.orderedQty 总和——已经答应客户、还没发货的量。
 * - 在途/已计划采购：DRAFT/SENT/TO_APPROVE/CONFIRMED 的 PurchaseOrderLine 未收货余量。
 *   包含 DRAFT 是刻意的：建议转出来的采购单就是 DRAFT，不算进来的话第二天会重复建议。
 *
 * 幂等：一天只生成一次（按 categoryGroupKey + generatedAt 当天范围判断），
 * 重复调用会先清掉今天已生成的 pending 建议再重新算一遍，用最新数据覆盖。
 */

export interface FreshSuggestionRow {
  productId: string
  productName: string
  dailyAvgOutbound: number
  futureDemand: number
  currentStock: number
  inTransitQty: number
  suggestedQty: number
  uomName: string | null
  supplierId: string | null
  supplierName: string | null
  estimatedCost: number | null
  priority: string
  reason: string
}

export async function generateFreshDailySuggestions(): Promise<FreshSuggestionRow[]> {
  const group = await prisma.categoryGroup.findUnique({ where: { key: 'FRESH_FROZEN' } })
  if (!group) return []

  const products = await prisma.product.findMany({
    where: { active: true, status: 'ACTIVE', category: { groupId: group.id } },
    select: {
      id: true,
      name: true,
      qtyOnHand: true,
      uom: { select: { name: true } },
      supplierInfos: {
        orderBy: { sequence: 'asc' },
        take: 1,
        include: { supplier: { select: { id: true, name: true } } },
      },
    },
  })
  if (products.length === 0) return []
  const productIds = products.map(p => p.id)

  // ⛔ 日界按**业务时区**（都柏林）切，不是进程本地时区。原来是 setHours(0,0,0,0)：
  // 生产容器跑 UTC，于是「近 3 日」的窗口与全站其它日口径错开最多一天，
  // 采购建议因此可能多算或少算一天的出货（台账 D8 在快照与缺货序列上修的是同一件事）。
  const todayStart = businessTodayStart()
  const threeDaysAgo = addBusinessDays(todayStart, -3)

  // 近3日已送达净出货
  const deliveredLines = await prisma.orderLine.findMany({
    where: {
      productId: { in: productIds },
      order: { status: 'COMPLETED', deliveryDate: { gte: threeDaysAgo, lt: todayStart } },
    },
    select: { productId: true, deliveredQty: true },
  })
  const outboundMap = new Map<string, number>()
  for (const l of deliveredLines) {
    outboundMap.set(l.productId, (outboundMap.get(l.productId) ?? 0) + toNum(l.deliveredQty))
  }

  // 已确认未来订单（还没发货）
  const futureLines = await prisma.orderLine.findMany({
    where: {
      productId: { in: productIds },
      order: { status: { in: ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] }, deliveryDate: { gte: todayStart } },
    },
    select: { productId: true, orderedQty: true },
  })
  const futureMap = new Map<string, number>()
  for (const l of futureLines) {
    futureMap.set(l.productId, (futureMap.get(l.productId) ?? 0) + toNum(l.orderedQty))
  }

  // 在途/已计划采购（未收货余量）。
  // ⚠️ 必须**包含 DRAFT / SENT / TO_APPROVE**，不能只算 CONFIRMED ——
  // 「建议转采购单」生成的正是一张 DRAFT 单（convert 路由写死 DRAFT）。
  // 只认 CONFIRMED 的话，采购员刚把建议转成采购单，第二天重新生成建议时
  // 那批货**又会被建议一遍**，照着下单就是重复采购。台账 F1 端到端测出来的。
  // RECEIVED 及之后不算：货已经进 qtyOnHand 了，再算一次会重复扣减。
  const inTransitLines = await prisma.purchaseOrderLine.findMany({
    where: {
      productId: { in: productIds },
      purchaseOrder: { status: { in: ['DRAFT', 'SENT', 'TO_APPROVE', 'CONFIRMED'] } },
    },
    select: { productId: true, orderedQty: true, receivedQty: true },
  })
  const inTransitMap = new Map<string, number>()
  for (const l of inTransitLines) {
    if (!l.productId) continue
    const remain = Math.max(0, toNum(l.orderedQty) - toNum(l.receivedQty))
    inTransitMap.set(l.productId, (inTransitMap.get(l.productId) ?? 0) + remain)
  }

  const rows: FreshSuggestionRow[] = []
  for (const p of products) {
    const dailyAvg = Number(((outboundMap.get(p.id) ?? 0) / 3).toFixed(3))
    const future = futureMap.get(p.id) ?? 0
    const stock = toNum(p.qtyOnHand)
    const inTransit = inTransitMap.get(p.id) ?? 0
    const need = dailyAvg + future
    const suggestedQty = Math.max(0, Number((need - stock - inTransit).toFixed(3)))
    if (suggestedQty <= 0) continue

    const bestSupplier = p.supplierInfos[0]
    const estimatedCost = bestSupplier
      ? Number((suggestedQty * toNum(bestSupplier.price)).toFixed(2))
      : null

    const shortageRate = need > 0 ? suggestedQty / need : 1
    let priority = 'normal'
    if (stock <= 0) priority = 'critical'
    else if (shortageRate > 0.5) priority = 'high'

    rows.push({
      productId: p.id,
      productName: p.name,
      dailyAvgOutbound: dailyAvg,
      futureDemand: future,
      currentStock: stock,
      inTransitQty: inTransit,
      suggestedQty,
      uomName: p.uom?.name ?? null,
      supplierId: bestSupplier?.supplier.id ?? null,
      supplierName: bestSupplier?.supplier.name ?? null,
      estimatedCost,
      priority,
      reason: `近3日日均出货 ${dailyAvg} + 未来已确认订单 ${future} - 现有库存 ${stock} - 在途采购 ${inTransit}`,
    })
  }

  // 幂等：清掉今天已生成的同品类 pending 建议，用最新数据覆盖
  await prisma.purchaseSuggestion.deleteMany({
    where: { status: 'pending', categoryGroupKey: 'FRESH_FROZEN', generatedAt: { gte: todayStart } },
  })

  if (rows.length > 0) {
    await prisma.purchaseSuggestion.createMany({
      data: rows.map(r => ({
        productId: r.productId,
        productName: r.productName,
        currentStock: r.currentStock,
        demandQty: r.dailyAvgOutbound + r.futureDemand,
        suggestedQty: r.suggestedQty,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        estimatedCost: r.estimatedCost,
        priority: r.priority,
        status: 'pending',
        categoryGroupKey: 'FRESH_FROZEN',
        reason: r.reason,
        dailyAvgOutbound: r.dailyAvgOutbound,
        futureDemand: r.futureDemand,
        inTransitQty: r.inTransitQty,
        uomName: r.uomName,
      })),
    })
  }

  return rows
}
