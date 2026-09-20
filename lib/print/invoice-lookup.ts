/**
 * 订单 → 发票号查询（server-only）
 *
 * Invoice.saleOrderIds 是字符串数组，不是外键（见 prisma/schema.prisma Invoice model），
 * 一张发票可能合并多笔订单，一笔订单此时可能尚未开票（打印送货单/汇总单时常见，发票是事后才开的）。
 */
import 'server-only'
import { prisma } from '@/lib/db'

/**
 * 返回 orderId -> 发票号（查不到的不在 map 里；同一订单被多张发票引用则逗号拼接）。
 *
 * 号有两个来源：
 *  1. `Order.invoiceNo` —— 打印销售单时分配的号（20260920 起，见 lib/invoice-number.ts）；
 *  2. `Invoice.saleOrderIds` —— 财务真正开出来的发票（含 Odoo 迁移的历史发票）。
 *
 * ⛔ **已经印出去的号优先，真发票只补空缺**，顺序不能反过来。
 * 反过来（真发票覆盖自发号）会出这种事：先打销售单，客户手上拿到 V59086；
 * 财务事后给这单开了 INV/2026/0123；再补印一张，同一张单变成 INV/2026/0123 —— 
 * 客户手上两张纸号不一样，会计当成两笔账。这正是 lib/invoice-number.ts 里
 * 幂等发号要防的事，在查询这一侧翻回来就等于白做。
 *
 * 与发号侧是配套的：`ensureInvoiceNumbers` 不给「已被真实发票覆盖」的订单发号，
 * 所以一张单只会落在两种状态之一 —— 有自发号（印它）或只有真发票（印真发票号），
 * 不存在两个号都有、还要挑一个的情况。唯一的例外是先印了销售单、财务**之后**才开票，
 * 那就该继续印当初给客户的那个号。
 */
export async function loadInvoiceNoMap(orderIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (orderIds.length === 0) return map

  const selfAssigned = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, invoiceNo: true },
  })
  for (const o of selfAssigned) {
    if (o.invoiceNo) map.set(o.id, o.invoiceNo)
  }

  const invoices = await prisma.invoice.findMany({
    where: { saleOrderIds: { hasSome: orderIds } },
    select: { name: true, saleOrderIds: true },
  })
  const fromInvoice = new Map<string, string>()
  for (const inv of invoices) {
    for (const orderId of inv.saleOrderIds) {
      if (!orderIds.includes(orderId)) continue
      const existing = fromInvoice.get(orderId)
      fromInvoice.set(orderId, existing ? `${existing}, ${inv.name}` : inv.name)
    }
  }
  // 只补空缺：已经印给客户的号不动（见函数头注释）
  for (const [orderId, name] of fromInvoice) {
    if (!map.has(orderId)) map.set(orderId, name)
  }

  return map
}
