import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

interface ItemJson {
  productId?: string
  productName?: string
  spec?: string
  price?: number
  quantity?: number
  // legacy seed alt names
  unitPrice?: number
  qty?: number
  subtotal?: number
  uomId?: string
  uomName?: string
  taxRate?: number
}

async function main() {
  console.log('🔄 开始回填 OrderLine...')
  const orders = await prisma.order.findMany({
    select: { id: true, code: true, status: true, items: true },
  })
  console.log(`📦 待处理订单: ${orders.length}`)

  // Get already-existing OrderLines to skip
  const existing = await prisma.orderLine.findMany({ select: { orderId: true } })
  const existingOrderIds = new Set(existing.map(l => l.orderId))
  console.log(`⏭  已有 OrderLine 的订单: ${existingOrderIds.size}（跳过）`)

  // Get invoices to know which orders are invoiced
  const invoices = await prisma.invoice.findMany({ select: { saleOrderIds: true } })
  const invoicedIds = new Set(invoices.flatMap(i => i.saleOrderIds as string[]))

  let totalLines = 0
  let processedOrders = 0
  for (const o of orders) {
    if (existingOrderIds.has(o.id)) continue
    const items = (o.items as unknown as ItemJson[] | null) ?? []
    if (!Array.isArray(items) || items.length === 0) continue

    const status = String(o.status)
    const isCompleted = status === 'COMPLETED'
    const isInvoiced = invoicedIds.has(o.id)

    const lineRows = items
      .filter(it => it.productId && it.productName && (typeof it.quantity === 'number' || typeof it.qty === 'number'))
      .map((it, idx) => {
        const ordered = Number(it.quantity ?? it.qty ?? 0)
        const delivered = isCompleted ? ordered : 0
        const invoiced  = isInvoiced ? ordered : 0
        const unitPrice = Number(it.price ?? it.unitPrice ?? 0)
        return {
          orderId: o.id,
          productId: it.productId!,
          productName: it.productName!,
          spec: it.spec ?? null,
          uomId: it.uomId ?? null,
          uomName: it.uomName ?? null,
          unitPrice,
          taxRate: it.taxRate ?? null,
          orderedQty: ordered,
          deliveredQty: delivered,
          invoicedQty: invoiced,
          subtotal: Number((unitPrice * ordered).toFixed(2)),
          sequence: idx,
        }
      })

    if (lineRows.length > 0) {
      await prisma.orderLine.createMany({ data: lineRows })
      totalLines += lineRows.length
    }
    processedOrders++
    if (processedOrders % 50 === 0) console.log(`  已处理 ${processedOrders}/${orders.length} 单`)
  }
  console.log(`✅ 回填完成：${processedOrders} 单，共 ${totalLines} 行`)
}

main().catch(e => { console.error('❌ 失败:', e); process.exit(1) }).finally(() => prisma.$disconnect())
