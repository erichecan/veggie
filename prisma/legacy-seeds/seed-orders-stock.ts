import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const STATUSES: Array<'PENDING' | 'CONFIRMED' | 'WAVE_ASSIGNED' | 'IN_DELIVERY' | 'COMPLETED'> = [
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED',
]
const SALESMEN = ['Hosea Hoo', 'Yunzhi Yang', 'Xiaohui Weng', 'Eric Chen', 'Lisa Wang']
const DRIVERS = ['1 am BAO', '2 am AFZAAL', '1 pm BAO', '2 pm AFZAAL', '6 collect warehouse']
const NOTES = ['', '', '', 'urgent', 'cash on delivery', 'check before send']

// Irish VAT rates: standard 23%, reduced 13.5%, zero-rated 0%, food ~0% or 4.76% for hospitality
const TAX_RATES = [0, 0, 0, 4.76, 4.76, 13.5]

function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pad(n: number, w = 3) { return String(n).padStart(w, '0') }

async function main() {
  console.log('🌱 开始添加 orders + stock 种子数据...')

  // Pick 50 random customers and 80 random products
  const customers = await prisma.customer.findMany({ take: 60, where: { isVendor: false } })
  const products = await prisma.product.findMany({ take: 100, where: { active: true } })

  // Load DriverSlot records for mapping DRIVERS → driverSlotId
  const allSlots = await prisma.driverSlot.findMany()
  const slotByName = new Map(allSlots.map(s => [s.driverName.toUpperCase(), s.id]))
  if (customers.length < 5) {
    console.error('❌ 客户太少，无法生成订单。请先 npm run prisma:seed')
    process.exit(1)
  }
  if (products.length < 10) {
    console.error('❌ 商品太少，无法生成订单。请先 npm run prisma:seed')
    process.exit(1)
  }
  console.log(`📦 候选客户 ${customers.length} 条，候选商品 ${products.length} 条`)

  // Operator user for createdById
  const operator = await prisma.user.findFirst({ where: { role: 'OPERATOR' } })
  const allUsers = await prisma.user.findMany({ take: 5 })
  const userIds = allUsers.map(u => u.id)
  if (userIds.length === 0) {
    console.error('❌ 没有用户，无法生成审计日志')
    process.exit(1)
  }

  // Enrich products: set commissionPrice (0.05–0.30 per unit) and standardPrice (55–75% of listPrice)
  console.log('💰 更新商品佣金价和成本价...')
  let productUpdateCount = 0
  for (const p of products) {
    const listPrice = Number(p.listPrice) || 10
    const commissionPrice = Math.round(listPrice * (0.05 + Math.random() * 0.10) * 100) / 100
    const standardPrice = Math.round(listPrice * (0.55 + Math.random() * 0.20) * 100) / 100
    await (prisma as unknown as { product: { update: (args: unknown) => Promise<unknown> } }).product.update({
      where: { id: p.id },
      data: { commissionPrice, standardPrice },
    })
    productUpdateCount++
  }
  console.log(`✅ 更新商品: ${productUpdateCount} 条`)

  // Generate 30+ orders for each status
  let totalOrders = 0
  let totalLines = 0
  let totalAuditLogs = 0

  for (const status of STATUSES) {
    const targetCount = 30
    for (let i = 1; i <= targetCount; i++) {
      const customer = rand(customers)
      const itemCount = randInt(1, 5)
      const items: { productId: string; productName: string; spec: string; price: number; quantity: number; subtotal: number }[] = []
      const lineRows: {
        productId: string; productName: string; spec: string | null;
        unitPrice: number; orderedQty: number; deliveredQty: number;
        invoicedQty: number; subtotal: number; sequence: number; taxRate: number
      }[] = []
      let total = 0
      for (let j = 0; j < itemCount; j++) {
        const p = rand(products)
        const quantity = randInt(1, 20)
        const price = Number(p.listPrice) || randInt(2, 50)
        const taxRate = rand(TAX_RATES)
        const subtotal = Math.round(quantity * price * 100) / 100
        items.push({ productId: p.id, productName: p.name, spec: '', price, quantity, subtotal })

        const delivered = status === 'COMPLETED' ? quantity : 0
        const invoiced  = status === 'COMPLETED' ? quantity : 0
        lineRows.push({
          productId: p.id, productName: p.name, spec: null,
          unitPrice: price, orderedQty: quantity, deliveredQty: delivered, invoicedQty: invoiced,
          subtotal, sequence: j, taxRate,
        })
        total += subtotal
      }

      const dayOffset = randInt(0, 14)
      const createdAt = new Date(Date.now() - dayOffset * 24 * 3600 * 1000 - randInt(0, 12) * 3600 * 1000)
      const code = `D${String(Date.now() % 1000000).slice(-6)}-${status[0]}${pad(i)}`
      const driverBatch = rand(DRIVERS)

      const created = await prisma.order.create({
        data: {
          code,
          createdById: operator?.id ?? null,
          createdByName: operator?.name ?? rand(SALESMEN),
          restaurantId: customer.id,
          restaurantName: customer.name,
          items: items as never,
          totalAmount: total,
          status,
          paymentMethod: rand(['ONLINE', 'CASH']) as 'ONLINE' | 'CASH',
          createdAt,
          quotationDate: createdAt,
          confirmationDate: status !== 'PENDING' ? new Date(createdAt.getTime() + randInt(1800, 7200) * 1000) : null,
          deliveryDate: status === 'COMPLETED' || status === 'IN_DELIVERY'
            ? new Date(createdAt.getTime() + 24 * 3600 * 1000) : null,
          internalNote: rand(NOTES) || null,
          salesman: rand(SALESMEN),
          deliveryBatch: driverBatch,
          driverSlotId: (() => { const parts = driverBatch.trim().split(/\s+/); const name = parts.length >= 3 ? parts.slice(2).join(' ') : parts[parts.length - 1]; return slotByName.get(name.toUpperCase()) ?? null })(),
          orderReturn: status === 'COMPLETED' ? Math.random() < 0.6 : false,
          lines: { create: lineRows },
        },
      })

      // Create OrderAuditLog records
      const creatorId = rand(userIds)
      const prismaAny = prisma as unknown as {
        orderAuditLog: {
          create: (args: unknown) => Promise<unknown>
        }
      }

      // All orders: "created" log
      await prismaAny.orderAuditLog.create({
        data: {
          orderId: created.id,
          userId: creatorId,
          action: 'created',
          totalBefore: null,
          totalAfter: total,
          changedFields: { status: { before: null, after: 'PENDING' }, itemCount: lineRows.length },
          createdAt: new Date(createdAt.getTime() + 60 * 1000),
        },
      })
      totalAuditLogs++

      // Non-PENDING orders: "confirmed" log
      if (status !== 'PENDING') {
        const confirmOffset = randInt(3600, 10800)
        const confirmTime = new Date(createdAt.getTime() + confirmOffset * 1000)
        const confirmorId = rand(userIds)
        await prismaAny.orderAuditLog.create({
          data: {
            orderId: created.id,
            userId: confirmorId,
            action: 'confirmed',
            totalBefore: total,
            totalAfter: total,
            changedFields: { status: { before: 'PENDING', after: 'CONFIRMED' } },
            createdAt: confirmTime,
          },
        })
        totalAuditLogs++
      }

      // COMPLETED orders: add an "updated" note
      if (status === 'COMPLETED') {
        const noteOffset = randInt(86400, 172800)
        await prismaAny.orderAuditLog.create({
          data: {
            orderId: created.id,
            userId: rand(userIds),
            action: 'note',
            changedFields: { message: 'Delivery confirmed by driver. Invoice issued.' },
            totalBefore: null,
            totalAfter: null,
            createdAt: new Date(createdAt.getTime() + noteOffset * 1000),
          },
        })
        totalAuditLogs++
      }

      totalLines += lineRows.length
    }
    totalOrders += targetCount
    console.log(`✅ ${status}: ${targetCount} 单`)
  }
  console.log(`📦 共写入 OrderLine: ${totalLines} 行`)
  console.log(`📝 共写入 OrderAuditLog: ${totalAuditLogs} 条`)
  console.log(`📊 总订单：${totalOrders}`)

  // Stock seed: pick 30+ products and create IN moves, update qtyOnHand
  const stockProducts = products.slice(0, 35)
  let stockMoves = 0
  for (const p of stockProducts) {
    const qty = randInt(50, 500)
    await prisma.stockMove.create({
      data: {
        productId: p.id,
        productName: p.name,
        type: 'IN',
        qty,
        note: 'Initial stock seed',
      },
    })
    await prisma.product.update({
      where: { id: p.id },
      data: { qtyOnHand: { increment: qty } },
    })
    stockMoves++
  }
  console.log(`✅ 库存入库记录：${stockMoves} 条`)

  console.log('\n🎉 种子数据完成！')
}

main().catch(e => { console.error('❌ 失败:', e); process.exit(1) }).finally(() => prisma.$disconnect())
