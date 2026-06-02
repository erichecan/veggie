/**
 * 回归测试：下单时本单选定的价格表(pricelistId)应覆盖客户档案默认值。
 *
 * 背景 bug：Place Order 页面的 Pricelist 下拉框未接通取价，且后端
 * resolveOrderLines 只按 customer.pricelistId 重算。对于 pricelistId=null
 * 的客户（如 D17 ABCT），即使选了 CITY CENTRE 也回退到 listPrice(11)，
 * 而 CITY CENTRE 里 Red Onion 的正确价是 2.2。
 *
 * 用真实 DB 数据验证后端覆盖逻辑。需要 .env.local 的 DATABASE_URL。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
import { resolveOrderLines } from '../lib/server-pricing'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const CITY_CENTRE_PL = 'pl_35'
const NONEXISTENT_PL = '__nonexistent_pl__'
let customerId = ''
let customerDefaultPl: string | null = null
let redOnionId = ''

before(async () => {
  const cust = await prisma.customer.findFirst({
    where: { name: { contains: 'ABCT' } },
    select: { id: true, pricelistId: true },
  })
  assert.ok(cust, '测试前置：未找到 ABCT 客户')
  customerId = cust!.id
  customerDefaultPl = cust!.pricelistId

  const red = await prisma.product.findFirst({
    where: { name: { contains: 'Red Onion 10kg' }, externalId: '18944' },
    select: { id: true },
  })
  assert.ok(red, '测试前置：未找到 Red Onion 10kg BAG (externalId=18944)')
  redOnionId = red!.id
})

after(async () => { await prisma.$disconnect() })

test('选定 CITY CENTRE 价格表覆盖后，Red Onion 单价应为 2.2', async () => {
  const { lines, pricelistId } = await resolveOrderLines(
    { prisma, restaurantId: customerId },
    [{ productId: redOnionId, quantity: 1, price: 11 }],
    { pricelistId: CITY_CENTRE_PL },
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0].authoritativeUnitPrice, 2.2, '覆盖价格表后应命中 CITY CENTRE 的 2.2 规则')
  assert.equal(pricelistId, CITY_CENTRE_PL, '返回的 pricelistId 应为本单选定值，用于持久化到订单')
})

test('不传覆盖时使用客户档案默认价格表（持久化值一致）', async () => {
  const { pricelistId } = await resolveOrderLines(
    { prisma, restaurantId: customerId },
    [{ productId: redOnionId, quantity: 1, price: 11 }],
  )
  assert.equal(pricelistId, customerDefaultPl, '无覆盖时应回落到客户档案默认价格表')
})

test('覆盖到不存在的价格表时回退牌价 11（覆盖被采纳且安全回退）', async () => {
  const { lines, pricelistId } = await resolveOrderLines(
    { prisma, restaurantId: customerId },
    [{ productId: redOnionId, quantity: 1, price: 11 }],
    { pricelistId: NONEXISTENT_PL },
  )
  assert.equal(lines[0].authoritativeUnitPrice, 11, '价格表不存在 → 回退 listPrice 11')
  assert.equal(pricelistId, NONEXISTENT_PL, '返回的 pricelistId 应为本单选定的覆盖值')
})
