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
  invoice: {
    findFirst(a: unknown): Promise<{ id: string; name?: string } | null>
    create(a: unknown): Promise<{ id: string }>
  }
  order: { findUnique(a: unknown): Promise<{ restaurantId: string; restaurantName: string; lines: Array<{ id: string; productId: string; productName: string; spec: string | null; deliveredQty: unknown; unitPrice: unknown; taxRate: unknown; isGift?: boolean }> } | null> }
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
  // 幂等:已被任何发票引用则跳过
  const existing = await tx.invoice.findFirst({ where: { saleOrderIds: { has: orderId } }, select: { id: true } })
  if (existing) return null

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { sequence: 'asc' } } },
  })
  if (!order) return null
  const cust = await tx.customer.findUnique({ where: { id: order.restaurantId }, select: { name: true, paymentTerm: true } })

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
  const adjustments = await tx.orderAdjustment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
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
  const dueDate = computeDueDate(new Date(), paymentTerms).toISOString().slice(0, 10)

  // 两个人同时完成订单可能取到同一个号：撞唯一约束就重新取号，最多 3 次
  for (let attempt = 0; ; attempt++) {
    const name = await nextInvoiceName(tx)
    try {
      return await tx.invoice.create({
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
          paymentTerms,
          dueDate,
        },
        select: { id: true },
      })
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 2) throw e
    }
  }
}
