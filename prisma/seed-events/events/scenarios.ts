/**
 * 异常场景：缺货差异 / 退货信用票 / 补货建议 / 通知 / 临期批次
 * 让 SORTER/OPERATOR/WAREHOUSE/FINANCE 的异常处理队列都有料。
 */
import { MARK, round2, round3, DAY, type Ctx } from '../shared'
import { recomputeOnHand } from '../inventory'
import type { MadeOrder } from './sales'

/** 缺货差异：挑可拣货订单的一行记 SHORTAGE */
async function makeDiscrepancies(ctx: Ctx, all: MadeOrder[]): Promise<void> {
  const pickable = all.filter((o) => o.stage === 'CONFIRMED' || o.stage === 'WAVE_ASSIGNED')
  const sample = ctx.rng.pickN(pickable, Math.min(8, pickable.length))
  for (const o of sample) {
    const line = await ctx.prisma.orderLine.findFirst({
      where: { orderId: o.id },
      select: { id: true, productId: true, productName: true, orderedQty: true },
    })
    if (!line) continue
    const ordered = Number(line.orderedQty)
    const picked = round3(Math.max(0, ordered - ctx.rng.int(1, Math.max(1, Math.floor(ordered / 2)))))
    await ctx.prisma.orderDiscrepancy.create({
      data: {
        code: ctx.disc.next(MARK.discPrefix),
        orderId: o.id,
        orderLineId: line.id,
        productId: line.productId,
        productName: line.productName,
        orderedQty: ordered,
        pickedQty: picked,
        diffQty: round3(ordered - picked),
        type: 'SHORTAGE',
        status: 'PENDING',
        reportedByName: '分货员',
        createdAt: o.date,
      },
    })
  }
}

/** 退货信用票：挂已完成订单 + StockMove(RETURN) 回库 */
async function makeCreditNotes(ctx: Ctx, completed: MadeOrder[]): Promise<void> {
  const sample = ctx.rng.pickN(completed, Math.min(6, completed.length))
  for (const o of sample) {
    const specs = ctx.rng.pickN(o.specs, Math.min(2, o.specs.length))
    if (specs.length === 0) continue
    let ex = 0
    let tax = 0
    const lines = specs.map((s) => {
      const qty = Math.max(1, Math.floor(s.qty / 2))
      const e = round2(s.product.sellPrice * qty)
      // product.taxRate 现在是百分数（见 personas.ts 的量纲说明），算税额要除 100
      const t = round2(e * s.product.taxRate / 100)
      ex += e
      tax += t
      return {
        productId: s.product.id,
        productName: s.product.name,
        quantity: qty,
        unitPrice: s.product.sellPrice,
        taxRate: s.product.taxRate,
        subtotalExTax: e,
        taxAmount: t,
        subtotalIncTax: round2(e + t),
        reason: '质量问题退货',
        sourceOrderId: o.id,
      }
    })
    ex = round2(ex)
    tax = round2(tax)
    const cn = await ctx.prisma.creditNote.create({
      data: {
        name: ctx.cn.next(MARK.cnPrefix),
        customerId: o.persona.id,
        customerName: o.persona.name,
        creditDate: new Date(o.date.getTime() + 3 * DAY),
        subtotalExTax: ex,
        totalTax: tax,
        totalIncTax: round2(ex + tax),
        status: 'CONFIRMED',
        createdBy: ctx.financeId,
        lines: { create: lines },
      },
      select: { id: true, name: true },
    })
    // 退货回库
    for (const l of lines) {
      await ctx.prisma.stockMove.create({
        data: {
          productId: l.productId,
          productName: l.productName,
          type: 'RETURN',
          qty: l.quantity,
          note: `${MARK.stockNote} 退货回库 ${cn.name}`,
          sourceType: 'CREDIT_NOTE',
          sourceId: cn.id,
          sourceRef: cn.name,
          movedAt: new Date(o.date.getTime() + 3 * DAY),
        },
      })
      // qtyOnHand 末尾统一重算
    }
  }
}

/** 补货建议：低库存商品（与 app 算法一致：demand-stock） */
async function makeSuggestions(ctx: Ctx): Promise<void> {
  const suppliers = await ctx.prisma.customer.findMany({
    where: { externalId: { startsWith: MARK.vendorExternalId } },
    select: { id: true, name: true },
  })
  const supName = new Map(suppliers.map((s) => [s.id, s.name]))
  const low = await ctx.prisma.product.findMany({
    where: { active: true },
    orderBy: { qtyOnHand: 'asc' },
    take: 15,
    select: { id: true, name: true, qtyOnHand: true },
  })
  for (const p of low) {
    const stock = Number(p.qtyOnHand)
    const demand = ctx.rng.int(20, 120)
    const shortage = Math.max(0, demand - stock)
    if (shortage <= 0) continue
    const prod = ctx.products.find((x) => x.id === p.id)
    const supplierId = prod?.supplierId ?? ctx.supplierIds[0]
    const rate = demand > 0 ? shortage / demand : 0
    await ctx.prisma.purchaseSuggestion.create({
      data: {
        tenantId: MARK.tenant,
        productId: p.id,
        productName: p.name,
        currentStock: round3(stock),
        demandQty: demand,
        suggestedQty: shortage,
        supplierId,
        supplierName: supName.get(supplierId) ?? null,
        estimatedCost: round2(shortage * (prod?.cost ?? 1)),
        priority: rate > 0.8 ? 'critical' : rate > 0.5 ? 'high' : 'normal',
        status: 'pending',
        generatedAt: ctx.now,
      },
    })
  }
}

/** 通知：缺货/订单事件，发给运营/仓库/财务 */
async function makeNotifications(ctx: Ctx): Promise<void> {
  const users = await ctx.prisma.user.findMany({
    where: { role: { in: ['OPERATOR', 'WAREHOUSE', 'FINANCE'] } },
    select: { id: true, role: true },
  })
  for (const u of users) {
    await ctx.prisma.notification.create({
      data: {
        tenantId: MARK.tenant,
        userId: u.id,
        type: u.role === 'WAREHOUSE' ? 'shortage' : 'order_update',
        title: u.role === 'WAREHOUSE' ? '库存预警' : '订单更新',
        body: u.role === 'WAREHOUSE' ? '有商品库存低于安全库存，请及时补货' : '今日有新订单待处理',
        read: false,
        createdAt: ctx.now,
      },
    })
  }
}

/** 临期批次：制造 3 天内到期的 Lot（含 IN 流水 + qtyOnHand），供仓库临期 KPI */
async function makeExpiringLots(ctx: Ctx): Promise<void> {
  const sample = ctx.rng.pickN(ctx.products, Math.min(6, ctx.products.length))
  for (const p of sample) {
    const qty = ctx.rng.int(5, 30)
    const arrivedAt = new Date(ctx.now.getTime() - ctx.rng.int(2, 6) * DAY)
    const lot = await ctx.prisma.lot.create({
      data: {
        lotNumber: ctx.lot.next(MARK.lotPrefix),
        productId: p.id,
        initialQty: qty,
        currentQty: qty,
        sourceType: 'ADJUSTMENT',
        sourceRef: `${MARK.lotPrefix}EXP`,
        bestBefore: new Date(ctx.now.getTime() + ctx.rng.int(1, 3) * DAY),
        arrivedAt,
        status: 'AVAILABLE',
      },
      select: { id: true },
    })
    await ctx.prisma.stockMove.create({
      data: {
        productId: p.id,
        productName: p.name,
        type: 'IN',
        qty,
        note: `${MARK.stockNote} 临期批次入库`,
        sourceType: 'ADJUSTMENT',
        sourceRef: `${MARK.lotPrefix}EXP`,
        lotId: lot.id,
        movedAt: arrivedAt,
      },
    })
    // qtyOnHand 末尾统一重算
  }
}

export async function runScenarios(ctx: Ctx, all: MadeOrder[], completed: MadeOrder[]): Promise<void> {
  await makeDiscrepancies(ctx, all)
  await makeCreditNotes(ctx, completed)
  await makeExpiringLots(ctx)
  // 重算库存，让补货建议读到真实 qtyOnHand（低库存排序 + currentStock）
  await recomputeOnHand(ctx.prisma)
  await makeSuggestions(ctx)
  await makeNotifications(ctx)
}
