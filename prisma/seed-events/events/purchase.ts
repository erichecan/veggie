/**
 * 采购链事件：采购单 → 收货入库(IN+Lot) → 供应商账单 + 记账
 * ============================================================================
 * 提速：收货用预生成 lotId + createMany 打包成一次往返；账单记账用预取科目 +
 * 内存凭证号 + $transaction。qtyOnHand 末尾由 recomputeOnHand 统一汇总。
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '../../../lib/generated/prisma/client'
import { MARK, round2, type Ctx, type ProductInfo, DAY } from '../shared'

interface PLine {
  product: ProductInfo
  qty: number
}
type Accounts = Record<string, string | undefined>

/** 建采购单（头+行，一次往返） */
async function createPO(
  ctx: Ctx,
  supplierId: string,
  specs: PLine[],
  orderDate: Date,
  status: 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED',
): Promise<{ id: string; name: string }> {
  const name = ctx.po.next(MARK.poPrefix)
  let exSum = 0
  let taxSum = 0
  let incSum = 0
  const received = status === 'RECEIVED'
  const lines = specs.map((s, idx) => {
    const ex = round2(s.qty * s.product.cost)
    const tax = round2(ex * s.product.taxRate)
    const inc = round2(ex + tax)
    exSum += ex
    taxSum += tax
    incSum += inc
    return {
      productId: s.product.id,
      productName: s.product.name,
      uomId: s.product.uomId,
      orderedQty: s.qty,
      receivedQty: received ? s.qty : 0,
      invoicedQty: received ? s.qty : 0,
      unitCost: s.product.cost,
      taxRate: s.product.taxRate,
      subtotalExTax: ex,
      taxAmount: tax,
      subtotalIncTax: inc,
      bestBefore: new Date(orderDate.getTime() + (7 + (idx % 21)) * DAY),
      sequence: idx,
    }
  })
  const po = await ctx.prisma.purchaseOrder.create({
    data: {
      name,
      supplierId,
      status,
      orderDate,
      expectedDate: new Date(orderDate.getTime() + 2 * DAY),
      subtotalExTax: round2(exSum),
      totalTax: round2(taxSum),
      totalIncTax: round2(incSum),
      createdBy: ctx.operatorId,
      confirmedAt: status === 'CONFIRMED' || received ? orderDate : null,
      lines: { create: lines },
    },
    select: { id: true, name: true },
  })
  return po
}

/** 收货入库：GoodsReceipt + Lot(createMany) + StockMove IN(createMany)，一次往返 */
async function receivePO(ctx: Ctx, po: { id: string; name: string }, specs: PLine[], arrivedAt: Date): Promise<void> {
  const lotData = specs.map((s, i) => ({
    id: randomUUID(),
    lotNumber: ctx.lot.next(MARK.lotPrefix),
    productId: s.product.id,
    initialQty: s.qty,
    currentQty: s.qty,
    sourceType: 'GOODS_RECEIPT',
    sourceId: po.id,
    sourceRef: po.name,
    bestBefore: new Date(arrivedAt.getTime() + (7 + (i % 21)) * DAY),
    arrivedAt,
    status: 'AVAILABLE',
  }))
  const moveData = specs.map((s, i) => ({
    productId: s.product.id,
    productName: s.product.name,
    type: 'IN' as const,
    qty: s.qty,
    note: `${MARK.stockNote} 收货入库 ${po.name}`,
    sourceType: 'PO',
    sourceId: po.id,
    sourceRef: po.name,
    lotId: lotData[i].id,
    movedAt: arrivedAt,
  }))
  await ctx.prisma.$transaction([
    ctx.prisma.goodsReceipt.create({
      data: {
        name: ctx.gr.next(MARK.grPrefix),
        purchaseOrderId: po.id,
        arrivedAt,
        receivedBy: ctx.operatorName,
        notes: MARK.stockNote,
        lines: specs.map((s) => ({ productId: s.product.id, productName: s.product.name, qty: s.qty, uomId: s.product.uomId, condition: 'ok' })),
      },
    }),
    ctx.prisma.lot.createMany({ data: lotData }),
    ctx.prisma.stockMove.createMany({ data: moveData }),
  ])
}

/** 供应商账单 + 记账（预取科目 + 内存凭证号 + 一次往返）：Dr 采购成本+进项 / Cr 应付 */
async function billPO(
  ctx: Ctx,
  po: { id: string; name: string },
  supplierId: string,
  specs: PLine[],
  billDate: Date,
  paid: boolean,
  acc: Accounts,
  nextJE: () => string,
): Promise<void> {
  let ex = 0
  let tax = 0
  const lines = specs.map((s) => {
    const e = round2(s.qty * s.product.cost)
    const t = round2(e * s.product.taxRate)
    ex += e
    tax += t
    return { productId: s.product.id, productName: s.product.name, qty: s.qty, unitCost: s.product.cost, subtotalIncTax: round2(e + t) }
  })
  ex = round2(ex)
  tax = round2(tax)
  const inc = round2(ex + tax)
  const billId = randomUUID()

  const ops: Prisma.PrismaPromise<unknown>[] = [
    ctx.prisma.vendorBill.create({
      data: {
        id: billId,
        name: ctx.vb.next(MARK.vbPrefix),
        purchaseOrderId: po.id,
        supplierId,
        billDate,
        dueDate: new Date(billDate.getTime() + 30 * DAY),
        lines,
        subtotalExTax: ex,
        totalTax: tax,
        totalIncTax: inc,
        amountPaid: paid ? inc : 0,
        amountDue: paid ? 0 : inc,
        status: 'POSTED',
        postedAt: billDate,
        paidAt: paid ? billDate : null,
      },
    }),
  ]
  if (acc['2100'] && acc['5000']) {
    const jeLines: Array<{ accountId: string; description: string; debit: number; credit: number; partnerId?: string; sequence: number }> = [
      { accountId: acc['5000'], description: `Purchases - ${po.name}`, debit: ex, credit: 0, sequence: 10 },
    ]
    if (tax > 0 && acc['1110']) jeLines.push({ accountId: acc['1110'], description: `VAT Input - ${po.name}`, debit: tax, credit: 0, sequence: 20 })
    jeLines.push({ accountId: acc['2100'], description: `AP - ${po.name}`, debit: 0, credit: inc, partnerId: supplierId, sequence: 30 })
    ops.push(
      ctx.prisma.journalEntry.create({
        data: {
          name: nextJE(),
          date: billDate,
          narration: `Vendor Bill ${po.name} posted (${MARK.jeMarker})`,
          sourceType: 'vendor_bill',
          sourceId: billId,
          status: 'POSTED',
          totalDebit: inc,
          totalCredit: inc,
          createdBy: ctx.operatorId,
          postedAt: billDate,
          lines: { create: jeLines },
        },
      }),
    )
  }
  await ctx.prisma.$transaction(ops)
}

/**
 * 初始进货 + 历史补货：让被卖的商品有充足库存，并产生采购历史。
 */
export async function runPurchasing(ctx: Ctx): Promise<void> {
  // 预取应付侧科目 + 内存凭证号
  const accRows = await ctx.prisma.account.findMany({ where: { code: { in: ['2100', '5000', '1110'] } }, select: { id: true, code: true } })
  const acc: Accounts = {}
  for (const a of accRows) acc[a.code] = a.id
  let jeSeq = await ctx.prisma.journalEntry.count()
  const nextJE = (): string => `JE-${String(++jeSeq).padStart(5, '0')}`

  // 估算每个商品的总需求
  const need = new Map<string, number>()
  for (const p of ctx.personas) {
    const orders = p.ordersPerMonth * ctx.scale.monthsBack
    const avgQty = 6
    const perBasket = (orders * ((p.linesPerOrder[0] + p.linesPerOrder[1]) / 2) * avgQty) / p.basket.length
    for (const prod of p.basket) need.set(prod.id, (need.get(prod.id) ?? 0) + perBasket)
  }
  const productById = new Map(ctx.products.map((p) => [p.id, p]))

  const start = new Date(ctx.now.getTime() - ctx.scale.monthsBack * 30 * DAY)
  const bySupplier = new Map<string, PLine[]>()
  for (const [pid, qty] of need) {
    const prod = productById.get(pid)
    if (!prod) continue
    const buyQty = Math.max(20, Math.ceil((qty * 1.4) / 5) * 5)
    if (!bySupplier.has(prod.supplierId)) bySupplier.set(prod.supplierId, [])
    bySupplier.get(prod.supplierId)!.push({ product: prod, qty: buyQty })
  }
  for (const [supplierId, specs] of bySupplier) {
    for (let i = 0; i < specs.length; i += 40) {
      const chunk = specs.slice(i, i + 40)
      const po = await createPO(ctx, supplierId, chunk, start, 'RECEIVED')
      await receivePO(ctx, po, chunk, new Date(start.getTime() + 2 * DAY))
      await billPO(ctx, po, supplierId, chunk, new Date(start.getTime() + 3 * DAY), ctx.rng.chance(0.7), acc, nextJE)
    }
  }

  // 近期补货：制造采购报表状态多样性（DRAFT/SENT/CONFIRMED，未收货）
  const recentStatuses: Array<'DRAFT' | 'SENT' | 'CONFIRMED'> = ['DRAFT', 'SENT', 'CONFIRMED']
  for (let k = 0; k < 6; k++) {
    const supplierId = ctx.rng.pick(ctx.supplierIds)
    const pickProducts = ctx.rng.pickN(ctx.products, ctx.rng.int(3, 8))
    const specs = pickProducts.map((p) => ({ product: p, qty: ctx.rng.int(10, 60) }))
    const days = ctx.rng.int(1, 20)
    await createPO(ctx, supplierId, specs, new Date(ctx.now.getTime() - days * DAY), ctx.rng.pick(recentStatuses))
  }
}
