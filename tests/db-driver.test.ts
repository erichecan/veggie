/**
 * 数据库驱动选择。
 *
 * 由来：迁到客户自有服务器后连的是标准 PostgreSQL，而 lib/db.ts 原本写死
 * PrismaNeon + @neondatabase/serverless 的 WebSocket 协议，连不上。改成双驱动后
 * 这里锁住选择逻辑：回滚窗口内 Cloud Run 仍要走 neon 分支，一旦推断错方向，
 * 表现是启动即连不上库——必须在测试里挡住，不能等部署时才发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDatabaseDriver } from '../lib/db-driver'

const NEON_URL = 'postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/veggie?sslmode=require'
const SOCKET_URL = 'postgresql://veggie@localhost/veggie?host=/var/run/postgresql'
const TCP_URL = 'postgresql://veggie:pw@127.0.0.1:5432/veggie'

test('未显式指定时，按 URL 推断：neon.tech 走 neon', () => {
  assert.equal(resolveDatabaseDriver(undefined, NEON_URL), 'neon')
})

test('未显式指定时，unix socket 与普通 TCP 串都走 pg', () => {
  assert.equal(resolveDatabaseDriver(undefined, SOCKET_URL), 'pg')
  assert.equal(resolveDatabaseDriver(undefined, TCP_URL), 'pg')
})

test('显式 DATABASE_DRIVER 覆盖 URL 推断', () => {
  // 演练迁移时可能拿 neon 串做只读比对，但要求走 pg 协议
  assert.equal(resolveDatabaseDriver('pg', NEON_URL), 'pg')
  assert.equal(resolveDatabaseDriver('neon', TCP_URL), 'neon')
})

test('大小写与空格不敏感', () => {
  assert.equal(resolveDatabaseDriver('PG', NEON_URL), 'pg')
  assert.equal(resolveDatabaseDriver('  Neon ', TCP_URL), 'neon')
})

test('拼错的值直接抛，不静默回退', () => {
  // 静默回退最危险：把 DATABASE_DRIVER 写成 "postgres" 却回退成 neon，
  // 在客户服务器上表现为启动时 WebSocket 连接超时，错误信息完全指不到根因。
  for (const bad of ['postgres', 'postgresql', 'pgsql', 'neon-serverless']) {
    assert.throws(
      () => resolveDatabaseDriver(bad, TCP_URL),
      /只能是 neon \/ pg/,
      `"${bad}" 应当直接抛错而不是回退`,
    )
  }
})

test('URL 缺失时不猜，直接抛', () => {
  assert.throws(() => resolveDatabaseDriver(undefined, undefined), /DATABASE_URL/)
  assert.throws(() => resolveDatabaseDriver(undefined, ''), /DATABASE_URL/)
})
