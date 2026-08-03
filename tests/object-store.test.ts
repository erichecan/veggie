/**
 * 上传文件落点 driver。
 *
 * 由来：upload-image 与 pdf-extract 两个路由直连 @google-cloud/storage 且把
 * https://storage.googleapis.com/... 绝对 URL 写进数据库，与「迁到客户自有服务器」
 * 冲突。抽成 driver 后锁住三件事：选择逻辑不许漂移、配置缺失要报出缺哪几个变量、
 * local driver 不许被路径穿越写到 UPLOAD_DIR 之外。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveObjectDriverName,
  getObjectStore,
  __resetObjectStore,
  assertSafeObjectPath,
  ObjectStoreConfigError,
} from '../lib/storage/object-store'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  __resetObjectStore()
})

test('resolveObjectDriverName: 未配置时默认 local（迁到自有服务器后开箱可用的那个）', () => {
  assert.equal(resolveObjectDriverName(undefined), 'local')
  assert.equal(resolveObjectDriverName(''), 'local')
  assert.equal(resolveObjectDriverName('  '), 'local')
})

test('resolveObjectDriverName: 大小写与空格不敏感', () => {
  assert.equal(resolveObjectDriverName('S3'), 's3')
  assert.equal(resolveObjectDriverName(' GCS '), 'gcs')
})

test('resolveObjectDriverName: 拼错的值直接抛，不静默回退', () => {
  // 与 backup-store 同样的语义：静默回退会让文件"成功"落到一个没人预期的地方。
  for (const bad of ['spaces', 'do-spaces', 'minio', 'google', 'disk']) {
    assert.throws(
      () => resolveObjectDriverName(bad),
      /只能是 local \/ s3 \/ gcs/,
      `"${bad}" 应当直接抛错而不是回退`,
    )
  }
})

test('assertSafeObjectPath: 拒绝路径穿越与绝对路径', () => {
  // objectPath 目前由 Date.now()+randomUUID 拼出、不含用户输入，但抽象层不能
  // 依赖调用方的自觉 —— 下一个调用点可能就把上传文件名拼进去了。
  for (const bad of [
    '../etc/passwd',
    'products/../../etc/passwd',
    '/etc/passwd',
    'products/..',
    'products/a\0b',
    'products/',
    '',
  ]) {
    assert.throws(() => assertSafeObjectPath(bad), /objectPath/, `"${bad}" 应被拒绝`)
  }
})

test('assertSafeObjectPath: 正常路径原样返回', () => {
  assert.equal(assertSafeObjectPath('products/1754-abc.jpg'), 'products/1754-abc.jpg')
  assert.equal(
    assertSafeObjectPath('purchase-docs/1754130000000-8f14e45f-ea8d.pdf'),
    'purchase-docs/1754130000000-8f14e45f-ea8d.pdf',
  )
})

test('local: 落盘到 UPLOAD_DIR，返回的是相对 URL 不是绝对 URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veggie-obj-'))
  process.env.STORAGE_DRIVER = 'local'
  process.env.UPLOAD_DIR = dir
  __resetObjectStore()

  const store = getObjectStore()
  const { url } = await store.put('products/x.jpg', Buffer.from('hello'), 'image/jpeg')

  // 相对路径是刻意的：换域名、加 CDN 都不需要改数据库里已存的值
  assert.equal(url, '/uploads/products/x.jpg')
  assert.equal(await readFile(join(dir, 'products/x.jpg'), 'utf8'), 'hello')

  await store.remove('products/x.jpg')
  await rm(dir, { recursive: true, force: true })
})

test('local: remove 不存在的对象不算错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veggie-obj-'))
  process.env.STORAGE_DRIVER = 'local'
  process.env.UPLOAD_DIR = dir
  __resetObjectStore()
  await getObjectStore().remove('products/nope.jpg')
  await rm(dir, { recursive: true, force: true })
})

test('local: 路径穿越在 put 时就被拒，不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veggie-obj-'))
  process.env.STORAGE_DRIVER = 'local'
  process.env.UPLOAD_DIR = dir
  __resetObjectStore()

  await assert.rejects(
    () => getObjectStore().put('../escaped.txt', Buffer.from('x'), 'text/plain'),
    /objectPath/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('s3 缺凭据时报出具体缺哪几个环境变量，不是 SDK 堆栈', () => {
  process.env.STORAGE_DRIVER = 's3'
  for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k]
  __resetObjectStore()

  assert.throws(
    () => getObjectStore(),
    (err: unknown) => {
      assert.ok(err instanceof ObjectStoreConfigError)
      const msg = (err as Error).message
      assert.match(msg, /S3_BUCKET/)
      assert.match(msg, /S3_ACCESS_KEY_ID/)
      assert.match(msg, /S3_SECRET_ACCESS_KEY/)
      return true
    },
  )
})

test('gcs 缺桶名时报错并指明它是遗留 driver', () => {
  process.env.STORAGE_DRIVER = 'gcs'
  delete process.env.GCS_BUCKET_NAME
  __resetObjectStore()
  assert.throws(() => getObjectStore(), /GCS_BUCKET_NAME/)
})
