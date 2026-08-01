import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDirectDatabaseUrl, buildBackupObjectPath, isExpired } from '../lib/backup'

test('getDirectDatabaseUrl 去掉连接串里的 -pooler 得到 direct 连接', () => {
  const pooled = 'postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
  assert.equal(
    getDirectDatabaseUrl(pooled),
    'postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/db?sslmode=require',
  )
})

test('getDirectDatabaseUrl 对已经是 direct 连接的串原样返回', () => {
  const direct = 'postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/db?sslmode=require'
  assert.equal(getDirectDatabaseUrl(direct), direct)
})

test('buildBackupObjectPath 生成带时间戳和 id 的路径，落在 backups/ 前缀下', () => {
  const date = new Date('2026-08-01T03:04:05.000Z')
  const path = buildBackupObjectPath(date, 'job123')
  assert.equal(path, 'backups/2026-08-01T03-04-05-000Z-job123.sql.gz')
})

test('isExpired: 超过保留天数的记录判定为过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const old = new Date('2026-06-01T00:00:00.000Z') // 61 天前
  assert.equal(isExpired(old, now, 30), true)
})

test('isExpired: 保留期内的记录判定为未过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const recent = new Date('2026-07-20T00:00:00.000Z') // 12 天前
  assert.equal(isExpired(recent, now, 30), false)
})

test('isExpired: 边界值——正好等于保留天数不算过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  assert.equal(isExpired(cutoff, now, 30), false)
})
