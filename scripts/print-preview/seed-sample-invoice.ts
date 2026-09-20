/**
 * 只在「预览用的本地快照库」里造一张结构正确的样例发票。
 * ============================================================================
 * 为什么需要：生产库 14.8 万张发票的 lines 是 Odoo 导入时的旧结构
 * `{amount, orderId, orderCode}`（按订单汇总），而发票打印页按当前的
 * InvoiceLine 类型渲染（productName/qty/unitPrice/taxAmount/...），
 * 两者对不上，页面读 line.taxAmount 直接抛 undefined → 500。
 *
 * 也就是说这张模板在**生产数据上是打不开的**。为了让客户至少能看到它的版式，
 * 这里用一张真实订单的行数据拼出一条符合当前结构的发票记录。
 *
 * ⛔ 只写本地快照容器（DATABASE_URL 指向 127.0.0.1:15433），不碰生产库。
 */
import { prisma } from '@/lib/db'

const SAMPLE_ID = 'preview-sample-invoice'

async function main() {
  const url = process.env.DATABASE_URL || ''
  if (!url.includes('127.0.0.1:15433')) {
    throw new Error(`拒绝执行：DATABASE_URL 不是本地快照库（当前 host 不含 127.0.0.1:15433）`)
  }

  const order = await prisma.order.findFirst({
    where: { lines: { some: {} } },
    include: { lines: { orderBy: { sequence: 'asc' } } },
    orderBy: { totalAmount: 'desc' },
  })
  if (!order) throw new Error('快照库里没有带行的订单')

  const lines = order.lines.map(l => {
    const qty = Number(l.orderedQty)
    const unitPrice = Number(l.unitPrice)
    const taxRate = Number(l.taxRate) || 0
    const subtotalExTax = Number(l.subtotal) || qty * unitPrice
    const taxAmount = subtotalExTax * taxRate
    return {
      productId: l.productId ?? '',
      productName: l.productName ?? '',
      spec: l.spec ?? '',
      qty,
      unitPrice,
      taxRate,
      subtotalExTax: Number(subtotalExTax.toFixed(2)),
      taxAmount: Number(taxAmount.toFixed(2)),
      subtotalIncTax: Number((subtotalExTax + taxAmount).toFixed(2)),
      isGift: l.isGift ?? false,
    }
  })

  const subtotalExTax = lines.reduce((s, l) => s + l.subtotalExTax, 0)
  const totalTax = lines.reduce((s, l) => s + l.taxAmount, 0)

  await prisma.invoice.upsert({
    where: { id: SAMPLE_ID },
    create: {
      id: SAMPLE_ID,
      name: 'V59086-SAMPLE',
      customerId: order.restaurantId,
      customerName: order.restaurantName,
      saleOrderIds: [order.id],
      lines,
      subtotalExTax,
      totalTax,
      totalIncTax: subtotalExTax + totalTax,
      amountPaid: 0,
      amountDue: subtotalExTax + totalTax,
      status: 'POSTED',
      paymentTerms: 'monthly',
    },
    update: { lines, subtotalExTax, totalTax, totalIncTax: subtotalExTax + totalTax },
  })

  console.log(`样例发票已写入快照库：id=${SAMPLE_ID} 客户=${order.restaurantName} 行数=${lines.length}`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
