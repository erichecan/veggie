import { assertReturnsResolved, lockReturnOrders } from '@/lib/return-invoice-guard'
import type { Prisma } from '@/lib/generated/prisma/client'
import { round2 } from '@/lib/decimal-helpers'
import { nextSequenceName } from '@/lib/sequence-number'
import { computeDueDate } from '@/lib/payment-terms'

/**
 * 订单完成自动生成 DRAFT 发票(P1-6/finance)
 * ================================================================================
 * 让"每张送达订单都有发票"由系统保证,从而 finance 应收口径可干净地用 Σ未付发票 amountDue
 * 而不漏单。草稿发票开不开给餐馆不影响内部应收;finance/会计再 Post/发送。
 * 幂等:订单已被任何发票引用则跳过。按 deliveredQty 开票(已交货量);无已交货行则不建。
 */

// ⛔ 方法写法（`findFirst(a: unknown): ...`）而非属性写法（`findFirst: (a: unknown) => ...`）：
// 前者 TS 按方法双变规则检查参数，真实 PrismaClient/事务客户端（参数类型比 unknown 更窄）
// 能直接满足这个结构化类型；写成属性会被按严格逆变检查，逼着调用方转 any 才能传参。
export type InvoiceTx = {
  $transaction?<T>(fn: (tx: InvoiceTx) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>
  orderReturn?: Prisma.TransactionClient['orderReturn']
  $queryRaw?: Prisma.TransactionClient['$queryRaw']
  invoice: {
    findFirst(a: unknown): Promise<{ id: string; name?: string } | null>
    create(a: unknown): Promise<{ id: string }>
  }
  order: { findUnique(a: unknown): Promise<{ restaurantId: string; restaurantName: string; deliveryDate?: Date | null; lines: Array<{ id: string; productId: string; productName: string; spec: string | null; deliveredQty: unknown; unitPrice: unknown; taxRate: unknown; isGift?: boolean }> } | null> }
  customer: { findUnique(a: unknown): Promise<{ name: string; paymentTerm?: string | null } | null> }
  orderAdjustment: { findMany(a: unknown): Promise<Array<{ id: string; type: string; label: string; amount: unknown }>> }
  /** 真实 PrismaClient 有它：发票号按数字取最大号（见 nextInvoiceName）；单测的 mock 没有时退回 findFirst */
  $queryRawUnsafe?(sql: string, ...values: unknown[]): Promise<unknown>
}

/**
 * 下一个发票号 INV-#####。
 * ⛔ 20261020 修：原来是「按 name 字符串倒序取第一张 + 1」。生产上有两套号并存——
 * 自动草稿是 5 位（INV-00012），发票页手动开票是 INV-${总数+1}（INV-148286）——字符串排序下
 * 'INV-0010' > 'INV-00009'、任何非数字尾巴（INV-A）都会让「最大号」取错，撞上已有号（唯一约束），
 * 而调用方 .catch 掉了错误：订单完成了，草稿发票却静默没生成。改成和其他单据一样按数字取最大号。
 */
export async function nextInvoiceName(tx: InvoiceTx): Promise<string> {
  if (tx.$queryRawUnsafe) return nextSequenceName(tx, 'Invoice', 'INV-', 5)
  const last = await tx.invoice.findFirst({
    where: { name: { startsWith: 'INV-' } },
    orderBy: { name: 'desc' },
    select: { name: true },
  })
  const n = last?.name ? (parseInt(last.name.slice(4), 10) || 0) : 0
  return `INV-${String(n + 1).padStart(5, '0')}`
}

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002'

export async function createDraftInvoiceForOrder(tx: InvoiceTx, orderId: string): Promise<{ id: string } | null> {
  if (tx.$transaction) return tx.$transaction(inner => createDraftInvoiceForOrderInTransaction(inner, orderId), { timeout: 60000, maxWait: 10000 })
  return createDraftInvoiceForOrderInTransaction(tx, orderId)
}

/** Requires the caller's existing transaction; never starts a nested transaction. */
export async function createDraftInvoiceForOrderInTransaction(tx: InvoiceTx, orderId: string): Promise<{ id: string } | null> {
  if (tx.$queryRaw) await lockReturnOrders(tx as Prisma.TransactionClient, [orderId])
  if (tx.orderReturn) await assertReturnsResolved(tx as Prisma.TransactionClient, [orderId])
  // 幂等:已被任何发票引用则跳过
  const existing = await tx.invoice.findFirst({ where: { saleOrderIds: { has: orderId } }, select: { id: true } })
  if (existing) return null

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { sequence: 'asc' } } },
  })
  if (!order) return null
  const cust = await tx.customer.findUnique({ where: { id: order.restaurantId }, select: { name: true, paymentTerm: true } })

  const adjustments = await tx.orderAdjustment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  const draft = buildOrderInvoiceDraft(orderId, order, cust, adjustments)
  if (!draft) return null

  // 两个人同时完成订单可能取到同一个号：撞唯一约束就重新取号，最多 3 次
  for (let attempt = 0; ; attempt++) {
    const name = await nextInvoiceName(tx)
    try {
      return await tx.invoice.create({
        data: { ...draft, name },
        select: { id: true },
      })
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 2) throw e
    }
  }
}

function buildOrderInvoiceDraft(
  orderId: string,
  order: NonNullable<Awaited<ReturnType<InvoiceTx['order']['findUnique']>>>,
  cust: Awaited<ReturnType<InvoiceTx['customer']['findUnique']>>,
  adjustments: Awaited<ReturnType<InvoiceTx['orderAdjustment']['findMany']>>,
) {
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
      // 赠品标记(20260918)随行快照进发票：打印时金额列印 GIFT 而不是 €0.00，
      // 否则客户在发票上分不清"送的"和"该收钱但价格填漏了"。
      // ⚠️ 本次改动之前开出的发票没有这个键，打印端按非赠品渲染（不拿 unitPrice===0
      // 反推——生产库里 0 价还有漏价/样品/Odoo 导入脏数据等成因）。
      isGift: l.isGift === true,
      qty, unitPrice: unit, taxRate: trn,
      subtotalExTax: ex, taxAmount: ta, subtotalIncTax: round2(ex + ta),
    })
  }
  if (lines.length === 0) return null

  // 订单调整行（折扣/配送费/差价修正，20260913）随发票一起体现，否则客户永远收不到
  // 这笔调整的账单——单据里发票才是"要客户签字认账"的那张，Order.totalAmount 本身
  // 不含调整（sales-accounting-tax-convention SSOT 不变），发票必须补上。
  // 按无税处理（税率 0）：这些不是应税商品销售，不重新分摊已开票商品的税额。
  for (const adj of adjustments) {
    const amount = round2(Number(adj.amount))
    subEx += amount
    lines.push({
      orderLineId: null,
      isAdjustment: true,
      adjustmentType: adj.type,
      productId: null, productName: adj.label, spec: '',
      qty: 1, unitPrice: amount, taxRate: 0,
      subtotalExTax: amount, taxAmount: 0, subtotalIncTax: amount,
    })
  }

  subEx = round2(subEx)
  tax = round2(tax)
  const inc = round2(subEx + tax)
  // 账期跟客户档案走、按账期推到期日（与 POST /api/invoices 同口径）。原来写死 monthly 且不填 dueDate，
  // 逾期检测（lib/credit-check.ts）对自动草稿发票永远查不到
  const paymentTerms = cust?.paymentTerm ?? 'monthly'
  const invoiceDate = order.deliveryDate ?? new Date()
  const dueDate = computeDueDate(invoiceDate, paymentTerms).toISOString().slice(0, 10)

  return {
    customerId: order.restaurantId,
    customerName: cust?.name ?? order.restaurantName,
    invoiceDate,
    saleOrderIds: [orderId],
    lines: lines as never,
    subtotalExTax: subEx,
    totalTax: tax,
    totalIncTax: inc,
    amountPaid: 0,
    amountDue: inc,
    status: 'DRAFT' as const,
    paymentTerms,
    dueDate,
  }
}

/** The caller locks the customer orders before entering this path. */
export async function createOrderInvoiceDraftsBatch(tx: Prisma.TransactionClient, ids: string[]) {
  if (!ids.length) return { created: 0, deferred: [] as string[], drafts: [] }
  const [existing, returns, requests, orders, receipts, intakes] = await Promise.all([
    tx.invoice.findMany({ where: { saleOrderIds: { hasSome: ids } }, select: { saleOrderIds: true } }),
    tx.orderReturn.findMany({ where: { orderId: { in: ids }, OR: [
      { status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } }, { status: 'APPROVED', workflowVersion: 2 },
    ] }, select: { orderId: true } }),
    tx.creditNoteRequest.findMany({ where: { sourceOrderId: { in: ids }, status: 'PENDING' }, select: { sourceOrderId: true } }),
    tx.order.findMany({ where: { id: { in: ids }, returnStatus: 'RETURNED' }, include: { lines: { orderBy: { sequence: 'asc' } } }, orderBy: { id: 'asc' } }),
    tx.receiptManifestEntry.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, scannedAt: true, paperIssue: true, paperReviewedAt: true } }),
    tx.returnIntake.findMany({ where: { candidateOrderIds: { hasSome: ids }, status: { in: ['OPEN', 'CUSTOMER_IDENTIFIED'] } }, select: { candidateOrderIds: true } }),
  ])
  const scanned = new Set(receipts.filter(row => row.scannedAt).map(row => row.orderId))
  const receiptHolds = receipts.filter(row => !scanned.has(row.orderId) || (row.paperIssue && !row.paperReviewedAt)).map(row => row.orderId)
  const deferred = [...new Set([...returns.map(row => row.orderId), ...receiptHolds, ...intakes.flatMap(row => row.candidateOrderIds).filter(id => ids.includes(id)), ...requests.map(row => row.sourceOrderId)])]
  const blocked = new Set(deferred)
  const invoiced = new Set(existing.flatMap(invoice => invoice.saleOrderIds))
  const eligible = orders.filter(order => !blocked.has(order.id) && !invoiced.has(order.id))
  if (!eligible.length) return { created: 0, deferred, drafts: [] }
  const [customers, adjustments] = await Promise.all([
    tx.customer.findMany({ where: { id: { in: [...new Set(eligible.map(order => order.restaurantId))] } }, select: { id: true, name: true, paymentTerm: true } }),
    tx.orderAdjustment.findMany({ where: { orderId: { in: eligible.map(order => order.id) } }, orderBy: { createdAt: 'asc' } }),
  ])
  const byCustomer = new Map(customers.map(customer => [customer.id, customer]))
  const byOrder = new Map<string, typeof adjustments>()
  for (const adjustment of adjustments) {
    const group = byOrder.get(adjustment.orderId) ?? []
    group.push(adjustment)
    byOrder.set(adjustment.orderId, group)
  }
  const drafts = eligible.flatMap(order => {
    const draft = buildOrderInvoiceDraft(order.id, order, byCustomer.get(order.restaurantId) ?? null, byOrder.get(order.id) ?? [])
    return draft ? [draft] : []
  })
  if (!drafts.length) return { created: 0, deferred, drafts: [] }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('order-invoice-number-batch'))`
  const first = Number((await nextInvoiceName(tx as unknown as InvoiceTx)).slice(4))
  const created = await tx.invoice.createManyAndReturn({ data: drafts.map((draft, index) => ({
    ...draft, name: `INV-${String(first + index).padStart(5, '0')}`,
  })), select: { id: true, saleOrderIds: true } })
  return { created: created.length, deferred, drafts: created }
}
