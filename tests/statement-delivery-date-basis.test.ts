/**
 * generateStatement 分期口径：20261026 从 confirmationDate 改成 deliveryDate
 * （见 lib/finance/statement.ts 文件头 ⑤ 与 docs/20261026-核销触发开票与对账单口径-tasks.md D1+D2）。
 *
 * 只锁一件事：同一张订单，deliveryDate 落在期内但 confirmationDate 落在期外时必须被计入；
 * 反过来（confirmationDate 落在期内但 deliveryDate 落在期外）必须被排除。
 * 用真实 DB 验证（generateStatement 直接查 Order 表）。没有 DATABASE_URL 时跳过。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
// 同 tests/generate-statements-cron.test.ts 的坑：lib/statements 顶层立即用
// process.env.DATABASE_URL 建连接，必须晚于 config() 动态 import。
let generateStatement: typeof import('../lib/statements')['generateStatement']

neonConfig.webSocketConstructor = ws

const DB_URL = process.env.DATABASE_URL
const NO_DB = !DB_URL && '未设置 DATABASE_URL：此文件需要真实数据库，本地跑 `npm test` 时才会执行'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: DB_URL ?? 'postgresql://unused' }) })

let customerId = ''
let productId = ''
let insideOrderId = ''
let outsideOrderId = ''
let statementId = ''

// 远早于任何真实业务数据的历史周，避免撞见真实客户的既有对账单
const PERIOD_START = '2020-02-03'
const PERIOD_END = '2020-02-09'
const INSIDE_DATE = '2020-02-05T00:00:00.000Z'
const OUTSIDE_DATE = '2019-01-01T00:00:00.000Z'

before(async () => {
  generateStatement = (await import('../lib/statements')).generateStatement
  if (NO_DB) return

  const customer = await prisma.customer.create({ data: { name: '__test_statement_delivery_date_basis__' } })
  customerId = customer.id
  const product = await prisma.product.findFirst({ select: { id: true } })
  if (!product) throw new Error('测试库里连一个 Product 都没有，无法造 OrderLine 夹具')
  productId = product.id

  // deliveryDate 在期内、confirmationDate 在期外 —— 新口径应计入
  const insideOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'CONFIRMED',
      deliveryDate: new Date(INSIDE_DATE), confirmationDate: new Date(OUTSIDE_DATE),
      lines: { create: [{ productId, productName: '__test_product__', unitPrice: 10, orderedQty: 10, deliveredQty: 10, subtotal: 100, taxRate: 0 }] },
    },
  })
  insideOrderId = insideOrder.id

  // confirmationDate 在期内、deliveryDate 在期外 —— 新口径应排除
  const outsideOrder = await prisma.order.create({
    data: {
      restaurantId: customerId, restaurantName: customer.name, status: 'CONFIRMED',
      deliveryDate: new Date(OUTSIDE_DATE), confirmationDate: new Date(INSIDE_DATE),
      lines: { create: [{ productId, productName: '__test_product__', unitPrice: 5, orderedQty: 10, deliveredQty: 10, subtotal: 50, taxRate: 0 }] },
    },
  })
  outsideOrderId = outsideOrder.id
})

after(async () => {
  if (NO_DB) return
  if (statementId) await prisma.statement.delete({ where: { id: statementId } }).catch(() => {})
  await prisma.orderLine.deleteMany({ where: { orderId: { in: [insideOrderId, outsideOrderId] } } })
  await prisma.order.deleteMany({ where: { id: { in: [insideOrderId, outsideOrderId] } } })
  await prisma.customer.delete({ where: { id: customerId } })
  await prisma.$disconnect()
})

test('按 deliveryDate 分期：deliveryDate 在期内的订单计入，即使 confirmationDate 在期外', { skip: !!NO_DB }, async () => {
  const result = await generateStatement(customerId, PERIOD_START, PERIOD_END)
  assert.equal(result.ok, true)
  if (!result.ok) return
  statementId = result.statement.id
  assert.ok(result.statement.orderIds.includes(insideOrderId), 'deliveryDate 在期内的单必须被计入')
  assert.ok(!result.statement.orderIds.includes(outsideOrderId), 'deliveryDate 在期外（即便 confirmationDate 在期内）的单不该被计入')
  assert.equal(Number(result.statement.totalSales), 100, '本期销售额应只有 insideOrder 的 100，不含 outsideOrder 的 50')
})
