/**
 * POST /api/cron/generate-statements — 定时按结算周期生成对账单
 *
 * 只锁两件最容易踩的坑：
 *   1. 没带 x-cron-secret（或带错）必须 401，不能悄悄放行
 *   2. 幂等性 —— 同一客户同一周期跑两次只留一条 Statement 记录，
 *      不能因为定时任务重复触发/手动补跑而生成两张账
 *
 * 用真实 DB 验证幂等性（generateStatement 直接查 Statement 表判重）。
 * 没有 DATABASE_URL 时跳过，与 tests/pricing-override.test.ts 同一约定。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
// ⚠️ lib/statements 与 cron 路由都 import `@/lib/db` 的单例（在模块顶层立即用
// process.env.DATABASE_URL 建连接）。TS import 会被打包器提到本文件所有顶层代码
// 之前执行，早于上面的 config() —— 单例会用尚未注入的空 DATABASE_URL 建连接，
// 之后整个进程都是错的连接。改用运行期动态 import，确保严格晚于 config()。
let generateStatement: typeof import('../lib/statements')['generateStatement']
let computeSettlementPeriod: typeof import('../lib/statements')['computeSettlementPeriod']
let cronHandler: typeof import('../app/api/cron/generate-statements/route')['POST']

neonConfig.webSocketConstructor = ws

const DB_URL = process.env.DATABASE_URL
const NO_DB = !DB_URL && '未设置 DATABASE_URL：此文件需要真实数据库，本地跑 `npm test` 时才会执行'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: DB_URL ?? 'postgresql://unused' }) })

let testCustomerId = ''
const createdStatementIds: string[] = []

before(async () => {
  const statementsMod = await import('../lib/statements')
  generateStatement = statementsMod.generateStatement
  computeSettlementPeriod = statementsMod.computeSettlementPeriod
  cronHandler = (await import('../app/api/cron/generate-statements/route')).POST

  if (NO_DB) return
  const customer = await prisma.customer.create({
    data: { name: '__test_generate_statements_cron__', settlementCycle: 'WEEKLY' },
  })
  testCustomerId = customer.id
})

after(async () => {
  if (NO_DB) return
  if (createdStatementIds.length) {
    await prisma.statement.deleteMany({ where: { id: { in: createdStatementIds } } })
  }
  if (testCustomerId) {
    await prisma.customer.delete({ where: { id: testCustomerId } })
  }
  await prisma.$disconnect()
})

test('无 x-cron-secret 返回 401', { skip: !!NO_DB }, async () => {
  const req = new Request('http://localhost/api/cron/generate-statements', { method: 'POST' })
  const res = await cronHandler(req)
  assert.equal(res.status, 401)
})

test('x-cron-secret 错误也返回 401', { skip: !!NO_DB }, async () => {
  const req = new Request('http://localhost/api/cron/generate-statements', {
    method: 'POST',
    headers: { 'x-cron-secret': 'wrong-secret-definitely-not-it' },
  })
  const res = await cronHandler(req)
  assert.equal(res.status, 401)
})

test('同一客户同一周期重复生成不产生第二条 Statement（幂等性）', { skip: !!NO_DB }, async () => {
  const periodStart = '2020-01-06' // 固定用一个远早于任何真实业务数据的历史周，避免撞见真实客户的既有对账单
  const periodEnd = '2020-01-12'

  const first = await generateStatement(testCustomerId, periodStart, periodEnd)
  assert.equal(first.ok, true, '第一次生成应该成功')
  if (first.ok) createdStatementIds.push(first.statement.id)

  const second = await generateStatement(testCustomerId, periodStart, periodEnd)
  assert.equal(second.ok, false, '第二次生成同一周期应该被拒绝')
  if (!second.ok) assert.equal(second.reason, 'duplicate')

  const count = await prisma.statement.count({
    where: { customerId: testCustomerId, periodStart: new Date('2020-01-06'), periodEnd: new Date('2020-01-12') },
  })
  assert.equal(count, 1, '数据库里必须恰好只有一条记录，而不是两条')
})

// computeSettlementPeriod 不碰数据库，无 DB 时也能跑
test('WEEKLY：给一个周三，算出的是上一个完整周一~周日', () => {
  // 2026-09-02 是周三（都柏林时区，此时仍是夏令时 BST=UTC+1），
  // 上一周应为 2026-08-24（周一）~ 2026-08-30（周日），都柏林 00:00 = 前一天 UTC 23:00
  const { periodStart, periodEnd } = computeSettlementPeriod('WEEKLY', new Date('2026-09-02T12:00:00Z'))
  assert.equal(periodStart.toISOString(), '2026-08-23T23:00:00.000Z')
  assert.equal(periodEnd.toISOString(), '2026-08-29T23:00:00.000Z')
})

test('MONTHLY：给9月里的一天，算出的是上一个完整自然月（8月1日~8月31日）', () => {
  // 8月仍是夏令时（BST=UTC+1），都柏林 00:00 = 前一天 UTC 23:00
  const { periodStart, periodEnd } = computeSettlementPeriod('MONTHLY', new Date('2026-09-02T12:00:00Z'))
  assert.equal(periodStart.toISOString(), '2026-07-31T23:00:00.000Z')
  assert.equal(periodEnd.toISOString(), '2026-08-30T23:00:00.000Z')
})

test('MONTHLY：跨年边界（1月给出的应是上一年12月）', () => {
  const { periodStart, periodEnd } = computeSettlementPeriod('MONTHLY', new Date('2026-01-15T12:00:00Z'))
  assert.equal(periodStart.toISOString(), '2025-12-01T00:00:00.000Z')
  assert.equal(periodEnd.toISOString(), '2025-12-31T00:00:00.000Z')
})

test('WEEKLY：都柏林夏令时期间（BST=UTC+1）边界不因时区偏移错位', () => {
  // 2026-07-08 是周三（夏令时期间），上一周应为 2026-06-29（周一）~ 2026-07-05（周日）
  const { periodStart, periodEnd } = computeSettlementPeriod('WEEKLY', new Date('2026-07-08T12:00:00Z'))
  assert.equal(periodStart.toISOString(), '2026-06-28T23:00:00.000Z') // 夏令时期间都柏林00:00 = UTC前一天23:00
  assert.equal(periodEnd.toISOString(), '2026-07-04T23:00:00.000Z')
})
