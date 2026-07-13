/**
 * 订单 → 发票号查询（server-only）
 *
 * Invoice.saleOrderIds 是字符串数组，不是外键（见 prisma/schema.prisma Invoice model），
 * 一张发票可能合并多笔订单，一笔订单此时可能尚未开票（打印送货单/汇总单时常见，发票是事后才开的）。
 */
import 'server-only'
import { prisma } from '@/lib/db'

/** 返回 orderId -> 发票号（未开票不在 map 里；同一订单被多张发票引用则逗号拼接） */
export async function loadInvoiceNoMap(orderIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (orderIds.length === 0) return map
  const invoices = await prisma.invoice.findMany({
    where: { saleOrderIds: { hasSome: orderIds } },
    select: { name: true, saleOrderIds: true },
  })
  for (const inv of invoices) {
    for (const orderId of inv.saleOrderIds) {
      if (!orderIds.includes(orderId)) continue
      const existing = map.get(orderId)
      map.set(orderId, existing ? `${existing}, ${inv.name}` : inv.name)
    }
  }
  return map
}
