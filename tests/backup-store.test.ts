/**
 * 备份落点 driver。
 *
 * 由来：2026-08-02 审计发现备份 3 次任务成功 0 次，最近一次的错误只有
 * "The specified bucket does not exist" —— 没人看得出该配什么。而且落点直连 GCS，
 * 与「迁到客户自有服务器」的目标架构冲突。改成 driver 抽象后，这里锁住两件事：
 * 选择逻辑不许漂移，配置缺失必须报出缺哪几个环境变量。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveDriverName,
  getBackupStore,
  __resetBackupStore,
  isEphemeralFilesystem,
  BackupStoreConfigError,
} from '../lib/storage/backup-store'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  __resetBackupStore()
})

test('resolveDriverName: 未配置时默认 local（迁到自有服务器后开箱可用的那个）', () => {
  assert.equal(resolveDriverName(undefined), 'local')
  assert.equal(resolveDriverName(''), 'local')
  assert.equal(resolveDriverName('  '), 'local')
})

test('resolveDriverName: 大小写与空格不敏感', () => {
  assert.equal(resolveDriverName('S3'), 's3')
  assert.equal(resolveDriverName(' GCS '), 'gcs')
})

test('resolveDriverName: 拼错的值直接抛，不静默回退成 local', () => {
  // 静默回退最危险：把 BACKUP_DRIVER 写成 "spaces" 却当成 local，
  // 备份会一直"成功"地落在容器本地磁盘上，重启即失，而没有任何人收到告警。
  for (const bad of ['spaces', 'S3-compatible', 'do-spaces', 'minio', 'GCS2']) {
    assert.throws(
      () => resolveDriverName(bad),
      /只能是 local \/ s3 \/ gcs/,
      `"${bad}" 应当直接抛错而不是回退`,
    )
  }
})

test('s3 缺凭据时报出具体缺哪几个环境变量，不是 SDK 堆栈', () => {
  process.env.BACKUP_DRIVER = 's3'
  delete process.env.S3_BUCKET
  delete process.env.S3_ACCESS_KEY_ID
  delete process.env.S3_SECRET_ACCESS_KEY
  __resetBackupStore()

  assert.throws(
    () => getBackupStore(),
    (err: unknown) => {
      assert.ok(err instanceof BackupStoreConfigError, '应当是 BackupStoreConfigError')
      const m = (err as Error).message
      assert.match(m, /S3_BUCKET/)
      assert.match(m, /S3_ACCESS_KEY_ID/)
      assert.match(m, /S3_SECRET_ACCESS_KEY/)
      assert.match(m, /DigitalOcean Spaces/, '要给出 DO Spaces 的配置提示')
      return true
    },
  )
})

test('gcs 缺桶名时提示这是遗留 driver、新环境该用 s3/local', () => {
  process.env.BACKUP_DRIVER = 'gcs'
  delete process.env.GCS_BACKUP_BUCKET_NAME
  __resetBackupStore()

  assert.throws(() => getBackupStore(), (err: unknown) => {
    const m = (err as Error).message
    assert.match(m, /GCS_BACKUP_BUCKET_NAME/)
    assert.match(m, /遗留/)
    return true
  })
})

test('local driver 能真的写进去、读出来、删掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-store-test-'))
  try {
    process.env.BACKUP_DRIVER = 'local'
    process.env.BACKUP_LOCAL_DIR = dir
    __resetBackupStore()

    const store = getBackupStore()
    assert.equal(store.driver, 'local')

    const src = join(dir, 'src.bin')
    const payload = Buffer.from('fake gzip payload')
    await writeFile(src, payload)

    const { sizeBytes } = await store.upload(src, 'backups/2026-08-02-abc.sql.gz')
    assert.equal(sizeBytes, payload.length)

    const got = await store.download('backups/2026-08-02-abc.sql.gz', 60_000)
    assert.equal(got.kind, 'stream', 'local 没有 URL 可签，必须走流')
    if (got.kind === 'stream') {
      assert.equal(got.sizeBytes, payload.length)
      got.stream.destroy()
    }

    const written = await readFile(join(dir, 'backups/2026-08-02-abc.sql.gz'))
    assert.deepEqual(written, payload)

    await store.remove('backups/2026-08-02-abc.sql.gz')
    await assert.rejects(() => readFile(join(dir, 'backups/2026-08-02-abc.sql.gz')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local driver 删除不存在的对象不算错（清理任务要幂等）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-store-test-'))
  try {
    process.env.BACKUP_DRIVER = 'local'
    process.env.BACKUP_LOCAL_DIR = dir
    __resetBackupStore()
    await getBackupStore().remove('backups/never-existed.sql.gz')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('describe() 不泄露密钥', () => {
  process.env.BACKUP_DRIVER = 's3'
  process.env.S3_BUCKET = 'veggie-backups'
  process.env.S3_ACCESS_KEY_ID = 'AKIAsecret'
  process.env.S3_SECRET_ACCESS_KEY = 'topsecret'
  process.env.S3_ENDPOINT = 'https://fra1.digitaloceanspaces.com'
  __resetBackupStore()

  const d = getBackupStore().describe()
  assert.match(d, /veggie-backups/)
  assert.doesNotMatch(d, /AKIAsecret/)
  assert.doesNotMatch(d, /topsecret/)
})

test('识别容器化无状态运行时', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
  assert.equal(isEphemeralFilesystem(env({})), false)
  assert.equal(isEphemeralFilesystem(env({ K_SERVICE: 'veggie' })), true)
  assert.equal(isEphemeralFilesystem(env({ K_REVISION: 'veggie-001' })), true)
  assert.equal(isEphemeralFilesystem(env({ DYNO: 'web.1' })), true)
  assert.equal(isEphemeralFilesystem(env({ FLY_APP_NAME: 'x' })), true)
})

test('Cloud Run 上落 local 直接拒绝——备份"成功"后消失比失败更危险', () => {
  process.env.BACKUP_DRIVER = 'local'
  process.env.K_SERVICE = 'veggie'
  delete process.env.BACKUP_ALLOW_EPHEMERAL_LOCAL
  __resetBackupStore()

  assert.throws(() => getBackupStore(), (err: unknown) => {
    assert.ok(err instanceof BackupStoreConfigError)
    const m = (err as Error).message
    assert.match(m, /容器化无状态环境/)
    assert.match(m, /BACKUP_DRIVER=s3/)
    return true
  })
})

test('显式设 BACKUP_ALLOW_EPHEMERAL_LOCAL=1 可以临时绕过', () => {
  process.env.BACKUP_DRIVER = 'local'
  process.env.K_SERVICE = 'veggie'
  process.env.BACKUP_ALLOW_EPHEMERAL_LOCAL = '1'
  __resetBackupStore()
  assert.equal(getBackupStore().driver, 'local')
})
