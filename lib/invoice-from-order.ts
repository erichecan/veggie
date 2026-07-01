import { round2 } from '@/lib/decimal-helpers'

/**
 * 订单完成自动生成 DRAFT 发票(P1-6/finance)
 * ================================================================================
 * 让"每张送达订单都有发票"由系统保证,从而 finance 应收口径可干净地用 Σ未付发票 amountDue
 * 而不漏单。草稿发票开不开给餐馆不影响内部应收;finance/会计再 Post/发送。
 * 幂等:订单已被任何发票引用则跳过。按 deliveredQty 开票(已交货量);无已交货行则不建。
 */

type InvoiceTx = {
  invoice: {
    findFirst: (a: unknown) => Promise<{ id: string; name?: string } | null>
    create: (a: unknown) => Promise<{ id: string }>
  }
  order: { findUnique: (a: unknown) => Promise<{ restaurantId: string; restaurantName: string; lines: Array<{ id: string; productId: string; productName: string; spec: string | null; deliveredQty: unknown; unitPrice: unknown; taxRate: unknown }> } | null> }
  customer: { findUnique: (a: unknown) => Promise<{ name: string } | null> }
}

async function nextInvoiceName(tx: InvoiceTx): Promise<string> {
  const last = await tx.invoice.findFirst({
    where: { name: { startsWith: 'INV-' } },
    orderBy: { name: 'desc' },
    select: { name: true },
  })
  const n = last?.name ? (parseInt(last.name.slice(4), 10) || 0) : 0
  return `INV-${String(n + 1).padStart(5, '0')}`
}

export async function createDraftInvoiceForOrder(tx: InvoiceTx, orderId: string): Promise<{ id: string } | null> {
  // 幂等:已被任何发票引用则跳过
  const existing = await tx.invoice.findFirst({ where: { saleOrderIds: { has: orderId } }, select: { id: true } })
  if (existing) return null

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { sequence: 'asc' } } },
  })
  if (!order) return null
  const cust = await tx.customer.findUnique({ where: { id: order.restaurantId }, select: { name: true } })

  let subEx = 0
  let tax = 0
  const lines: Array<Record<string, unknown>> = []
  for (const l of order.lines) {
    const qty = Number(l.deliveredQty) || 0
    if (qty <= 0) continue
    const unit = Number(l.unitPrice)
    const tr = Number(l.taxRate ?? 0)
    const trn = tr > 1 ? tr / 100 : tr
    const ex = round2(qty * unit)
    const ta = round2(ex * trn)
    subEx += ex
    tax += ta
    lines.push({
      // B-2: 发票行携带 orderLineId,供过账时按行精确回写 invoicedQty(部分/多次开票不误刷全单)
      orderLineId: l.id,
      productId: l.productId, productName: l.productName, spec: l.spec ?? '',
      qty, unitPrice: unit, taxRate: trn,
      subtotalExTax: ex, taxAmount: ta, subtotalIncTax: round2(ex + ta),
    })
  }
  if (lines.length === 0) return null

  subEx = round2(subEx)
  tax = round2(tax)
  const inc = round2(subEx + tax)
  const name = await nextInvoiceName(tx)

  return tx.invoice.create({
    data: {
      name,
      customerId: order.restaurantId,
      customerName: cust?.name ?? order.restaurantName,
      saleOrderIds: [orderId],
      lines: lines as never,
      subtotalExTax: subEx,
      totalTax: tax,
      totalIncTax: inc,
      amountPaid: 0,
      amountDue: inc,
      status: 'DRAFT',
      paymentTerms: 'monthly',
    },
    select: { id: true },
  })
}
