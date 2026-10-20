/**
 * 采购单确认后自动生成 DRAFT 供应商账单
 * ================================================================================
 * 采购单一旦被供应商接单(CONFIRMED)，应付款项就已经确定，finance 需要提前知道即将
 * 付多少钱，而不是等到收货/开票才第一次看到这笔支出。草稿账单不代表已过账，
 * finance/会计后续在 vendor-bills 里核对、Post。
 * 幂等：一个采购单只生成一次账单（按 purchaseOrderId 查重）。
 */
import { nextSequenceName } from '@/lib/sequence-number'
import { recomputeVendorBillBalance } from '@/lib/finance/vendor-bill-balance'

type VendorBillTx = {
  vendorBill: {
    findFirst: (a: unknown) => Promise<{ id: string } | null>
    create: (a: unknown) => Promise<{ id: string; name: string }>
  }
  /** 发号(lib/sequence-number.ts)用 */
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<Array<{ max: number | null }>>
  purchaseOrder: {
    findUnique: (a: unknown) => Promise<{
      id: string
      name: string
      supplierId: string
      currency: string
      exchangeRate: unknown
      exchangeRatePending: boolean
      subtotalExTax: unknown
      totalTax: unknown
      totalIncTax: unknown
      subtotalExTaxEur: unknown
      totalTaxEur: unknown
      totalIncTaxEur: unknown
      lines: Array<{
        productId: string | null
        productName: string
        orderedQty: unknown
        unitCost: unknown
        taxRate: unknown
        subtotalExTax: unknown
        taxAmount: unknown
        subtotalIncTax: unknown
        unitCostEur: unknown
        subtotalExTaxEur: unknown
        taxAmountEur: unknown
        subtotalIncTaxEur: unknown
      }>
    } | null>
  }
}

type PoForBill = NonNullable<Awaited<ReturnType<VendorBillTx['purchaseOrder']['findUnique']>>>

// 账单金额一律用折合欧元的字段：币种非欧元时 subtotalExTax 等原币字段只用于展示原始发票，
// 应付账款/会计分录必须是欧元(20260713 汇率换算改造)
function billLinesFromPo(po: PoForBill) {
  return po.lines.map(l => ({
    productId: l.productId ?? '',
    productName: l.productName,
    qty: Number(l.orderedQty),
    unitCost: Number(l.unitCostEur ?? l.unitCost),
    taxRate: Number(l.taxRate ?? 0),
    subtotalExTax: Number(l.subtotalExTaxEur ?? l.subtotalExTax),
    taxAmount: Number(l.taxAmountEur ?? l.taxAmount),
    subtotalIncTax: Number(l.subtotalIncTaxEur ?? l.subtotalIncTax),
  }))
}

/**
 * 采购单下单量/金额变了（如退货下修，20261020）之后，把它的 DRAFT 账单按 PO 现状重算一遍。
 * 只动草稿：已过账/已付的账单是财务凭证，差额由财务另开贷记单处理。返回被同步的账单号，没有草稿则 null。
 */
export async function syncDraftVendorBillFromPurchaseOrder(
  tx: VendorBillTx & { vendorBill: { update: (a: unknown) => Promise<unknown> } },
  purchaseOrderId: string,
): Promise<string | null> {
  const bill = await tx.vendorBill.findFirst({ where: { purchaseOrderId, status: 'DRAFT' }, select: { id: true, name: true } }) as { id: string; name?: string } | null
  if (!bill) return null
  const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { lines: true } })
  if (!po || po.exchangeRatePending) return null
  const totalIncTax = Number(po.totalIncTaxEur ?? po.totalIncTax)
  await tx.vendorBill.update({
    where: { id: bill.id },
    data: {
      lines: billLinesFromPo(po) as never,
      subtotalExTax: Number(po.subtotalExTaxEur ?? po.subtotalExTax),
      totalTax: Number(po.totalTaxEur ?? po.totalTax),
      totalIncTax,
    },
  })
  // 未付余额只由付款流水重算（lib/finance/vendor-bill-balance.ts），这里不直接写 amountDue
  await recomputeVendorBillBalance(tx as never, bill.id)
  return bill.name ?? bill.id
}

export async function createDraftVendorBillForPurchaseOrder(
  tx: VendorBillTx,
  purchaseOrderId: string,
): Promise<{ id: string; name: string; supplierId: string; totalIncTax: number } | null> {
  // 幂等：已生成过账单则跳过
  const existing = await tx.vendorBill.findFirst({ where: { purchaseOrderId }, select: { id: true } })
  if (existing) return null

  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { lines: true },
  })
  if (!po || po.lines.length === 0) return null
  // 汇率待确认时不能生成账单——欧元金额未知，宁可让财务手动补录也不能算出一个错的应付款
  // (正常不会走到这，PATCH action=confirm 已经挡在前面；这里是防御性兜底，20260713)。
  if (po.exchangeRatePending) return null

  const lines = billLinesFromPo(po)

  // 现有最大号 + 1，不用 count+1(删过/有空号就撞号，采购单确认时自动建账单就会 500；见 lib/sequence-number.ts)
  const name = await nextSequenceName(tx, 'VendorBill', 'VB-', 5)
  const totalIncTax = Number(po.totalIncTaxEur ?? po.totalIncTax)

  const bill = await tx.vendorBill.create({
    data: {
      name,
      purchaseOrderId: po.id,
      supplierId: po.supplierId,
      billDate: new Date(),
      lines: lines as never,
      currency: po.currency,
      exchangeRate: po.exchangeRate ?? 1,
      subtotalExTax: Number(po.subtotalExTaxEur ?? po.subtotalExTax),
      totalTax: Number(po.totalTaxEur ?? po.totalTax),
      totalIncTax,
      amountPaid: 0,
      amountDue: totalIncTax,
      status: 'DRAFT',
      notes: `采购单 ${po.name} 确认后自动生成`,
    },
    select: { id: true, name: true },
  })

  return { id: bill.id, name: bill.name, supplierId: po.supplierId, totalIncTax }
}
