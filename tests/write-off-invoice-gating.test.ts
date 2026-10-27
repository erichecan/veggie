/**
 * 20261026 code-review 发现的两处回归：
 *   1) getReturnOrderLines() 单行 0 送达量被 `|| orderedQty` 兜底吃掉（lib/accounting/returns.ts）；
 *      改成按整单判断（整单全 0 才兜底），这里锁住"同单里有的行 0、有的行非 0"这种真实差异不被覆盖。
 *   2) findUninvoicedCompletedOrders() 没过滤 returnStatus，COMPLETED 但还没核销的单（新设计下的
 *      正常中间状态）会被误判成"漏开票"；加 returnStatus=RETURNED 条件后锁住这个过滤。
 * 用真实 DB 验证。没有 DATABASE_URL 时跳过。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
let getReturnOrderLines: typeof import('../lib/accounting/returns')['getReturnOrderLines']
let findUninvoicedCompletedOrders: typeof import('../lib/ledger-check')['findUninvoicedCompletedOrders']

neonConfig.webSocketConstructor = ws

const DB_URL = process.env.DATABASE_URL
const NO_DB = !DB_URL && '未设置 DATABASE_URL：此文件需要真实数据库，本地跑 `npm test` 时才会执行'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: DB_URL ?? 'postgresql://unused' }) })

let customerId = ''
let productId = ''
let mixedOrderId = ''
let allZeroOrderId = ''
let pendingCompletedOrderId = ''
let returnedCompletedOrderId = ''

before(async () => {
  ;({ getReturnOrderLines } = await import('../lib/accounting/returns'))
  ;({ findUninvoicedCompletedOrders } = await import('../lib/ledger-check'))
  if (NO_DB) return

  const customer = await prisma.customer.create({ data: { name: '__test_writeoff_invoice_gating__' } })
  customerId = customer.id
  const product = await prisma.product.findFirst({ select: { id: true } })
  if (!product) throw new Error('测试库里连一个 Product 都没有，无法造 OrderLine 夹具')
  productId = product.id

  // 一行真实送达、一行真实拒收（0）—— 不该被兜底吃掉
  const mixedOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'COMPLETED', returnStatus: 'PENDING',
      lines: { create: [
        { productId, productName: '__p_delivered__', unitPrice: 10, orderedQty: 5, deliveredQty: 5, subtotal: 50, taxRate: 0 },
        { productId, productName: '__p_rejected__', unitPrice: 10, orderedQty: 5, deliveredQty: 0, subtotal: 50, taxRate: 0 },
      ] },
    },
  })
  mixedOrderId = mixedOrder.id

  // 整单两行都是 0（从没记过）—— 该兜底成下单量
  const allZeroOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'COMPLETED', returnStatus: 'PENDING',
      lines: { create: [
        { productId, productName: '__p_unrecorded_1__', unitPrice: 10, orderedQty: 3, deliveredQty: 0, subtotal: 30, taxRate: 0 },
        { productId, productName: '__p_unrecorded_2__', unitPrice: 10, orderedQty: 4, deliveredQty: 0, subtotal: 40, taxRate: 0 },
      ] },
    },
  })
  allZeroOrderId = allZeroOrder.id

  // COMPLETED 但还没核销确认（新设计下的正常中间态）—— 不该被当成"漏开票"
  const pendingCompletedOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'COMPLETED', returnStatus: 'PENDING',
      lines: { create: [{ productId, productName: '__p_pending__', unitPrice: 10, orderedQty: 1, deliveredQty: 1, subtotal: 10, taxRate: 0 }] },
    },
  })
  pendingCompletedOrderId = pendingCompletedOrder.id

  // COMPLETED 且已核销确认、没有发票 —— 该被当成"漏开票"
  const returnedCompletedOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'COMPLETED', returnStatus: 'RETURNED',
      lines: { create: [{ productId, productName: '__p_returned__', unitPrice: 10, orderedQty: 1, deliveredQty: 1, subtotal: 10, taxRate: 0 }] },
    },
  })
  returnedCompletedOrderId = returnedCompletedOrder.id
})

after(async () => {
  if (NO_DB) return
  const orderIds = [mixedOrderId, allZeroOrderId, pendingCompletedOrderId, returnedCompletedOrderId]
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.customer.delete({ where: { id: customerId } })
  await prisma.$disconnect()
})

test('getReturnOrderLines：同单里有的行 0、有的行非 0 ——真实 0 不被兜底覆盖', { skip: !!NO_DB }, async () => {
  const lines = await getReturnOrderLines(mixedOrderId)
  const delivered = lines.find(l => l.productName === '__p_delivered__')
  const rejected = lines.find(l => l.productName === '__p_rejected__')
  assert.equal(delivered?.deliveredQty, 5)
  assert.equal(rejected?.deliveredQty, 0, '整单还有其它行非 0，这行的 0 是真实拒收，不该被兜底成下单量')
})

test('getReturnOrderLines：整单都是 0（从没记过）——兜底成下单量', { skip: !!NO_DB }, async () => {
  const lines = await getReturnOrderLines(allZeroOrderId)
  for (const l of lines) {
    assert.equal(l.deliveredQty, l.orderedQty, `${l.productName} 整单都没记过送达量，应兜底展示下单量`)
  }
})

test('findUninvoicedCompletedOrders：只报已核销确认（RETURNED）的单，不报 PENDING 的中间态', { skip: !!NO_DB }, async () => {
  const rows = await findUninvoicedCompletedOrders()
  const ids = new Set(rows.map(r => String(r.id)))
  assert.ok(!ids.has(pendingCompletedOrderId), 'COMPLETED 但还没核销确认的单，是新设计下正常的中间态，不该被当成漏开票')
  assert.ok(ids.has(returnedCompletedOrderId), 'COMPLETED 且已核销确认、没有发票的单，应该被探针找出来')
})
