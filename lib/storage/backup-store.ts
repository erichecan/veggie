/**
 * 备份产物落点 —— driver 抽象
 * ============================================================================
 * 为什么有这一层：按项目部署铁律，GCP + Neon 只是临时宿主，功能做完要整体迁到客户
 * 自有的 DigitalOcean 服务器。备份如果直连 `@google-cloud/storage`，迁移时得连代码
 * 一起改；而且合同要求「至少一份备份保存在不同于主服务器的位置」，落点必须是迁移后
 * 依然存在的东西。
 *
 * 所以落点做成三个 driver，由 `BACKUP_DRIVER` 选：
 *
 *   local  —— 落本地磁盘（默认）。迁到自有服务器后开箱可用；配合 systemd timer +
 *             rsync/rclone 推到异地即可满足合同的异地留存要求。
 *   s3     —— 任何 S3 兼容对象存储：DigitalOcean Spaces、MinIO、Backblaze B2、AWS S3。
 *             这是**迁移后的目标形态**——Cloud Run 上现在能用，droplet 上照样能用。
 *   gcs    —— 遗留兼容，仅为让当前 Cloud Run 部署不断。⚠️ 不要在新环境里选它。
 *
 * ⛔ 本模块不会替你开通任何云资源。桶要自己建，缺配置时会明确报出缺哪几个环境变量，
 *    而不是抛一个 404 的 SDK 堆栈（2026-08-02 之前正是这样：备份 3 次全失败，
 *    最近一次的错误只有 "The specified bucket does not exist"，没人看得出该配什么）。
 */
import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

export type BackupDriverName = 'local' | 's3' | 'gcs'

/** 下载方式：对象存储给签名 URL，本地磁盘只能由服务端读流转发 */
export type BackupDownload =
  | { kind: 'url'; url: string }
  | { kind: 'stream'; stream: Readable; sizeBytes: number }

export interface BackupStore {
  readonly driver: BackupDriverName
  /** 把本地临时文件放到 objectPath，返回落点实际大小 */
  upload(localPath: string, objectPath: string): Promise<{ sizeBytes: number }>
  /** 删除；对象不存在不算错 */
  remove(objectPath: string): Promise<void>
  download(objectPath: string, ttlMs: number): Promise<BackupDownload>
  /** 供报错与运维排查用的一行描述，不含任何密钥 */
  describe(): string
}

/** 配置缺失时抛这个，携带该 driver 需要的全部环境变量名 */
export class BackupStoreConfigError extends Error {
  constructor(driver: BackupDriverName, missing: string[], hint: string) {
    super(
      `备份落点未配置完整：BACKUP_DRIVER=${driver} 还缺 ${missing.join('、')}。${hint}`,
    )
    this.name = 'BackupStoreConfigError'
  }
}

function requireEnv(driver: BackupDriverName, names: string[], hint: string): Record<string, string> {
  const missing = names.filter(n => !process.env[n])
  if (missing.length > 0) throw new BackupStoreConfigError(driver, missing, hint)
  return Object.fromEntries(names.map(n => [n, process.env[n] as string]))
}

// ── local ───────────────────────────────────────────────────────────────────

/**
 * 容器化无状态运行时（Cloud Run / Fly / Heroku 之类）的本地磁盘重启即失。
 * 在这种环境里落 local，备份会"成功"然后悄无声息地消失——比响亮地失败危险得多。
 * 所以这里直接拒绝，逼配一个真正持久的落点。
 */
export function isEphemeralFilesystem(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.K_SERVICE || env.K_REVISION || env.DYNO || env.FLY_APP_NAME)
}

function localStore(): BackupStore {
  if (isEphemeralFilesystem() && process.env.BACKUP_ALLOW_EPHEMERAL_LOCAL !== '1') {
    throw new BackupStoreConfigError(
      'local',
      ['BACKUP_DRIVER=s3'],
      '当前运行在容器化无状态环境（Cloud Run 等），本地磁盘重启即失，' +
      '落 local 的备份会"成功"后悄悄消失。请改配 S3 兼容对象存储（见 docs/20260802-backup-storage-config.md）。' +
      '确实只想临时试跑可设 BACKUP_ALLOW_EPHEMERAL_LOCAL=1 绕过。',
    )
  }
  const root = resolve(process.env.BACKUP_LOCAL_DIR ?? './backups')
  return {
    driver: 'local',
    async upload(localPath, objectPath) {
      const dest = join(root, objectPath)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(localPath, dest)
      const s = await stat(dest)
      return { sizeBytes: s.size }
    },
    async remove(objectPath) {
      await unlink(join(root, objectPath)).catch(() => {})
    },
    async download(objectPath) {
      const full = join(root, objectPath)
      const s = await stat(full)
      return { kind: 'stream', stream: createReadStream(full), sizeBytes: s.size }
    },
    describe: () => `local(${root})`,
  }
}

// ── s3 兼容（DigitalOcean Spaces / MinIO / B2 / AWS S3）──────────────────────

function s3Store(): BackupStore {
  const env = requireEnv(
    's3',
    ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    'DigitalOcean Spaces 还需 S3_ENDPOINT（如 https://fra1.digitaloceanspaces.com）与 S3_REGION（如 fra1）；' +
    'AWS S3 只需 S3_REGION。桶需自行创建，本模块不会替你开通。',
  )
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  if (!endpoint && !process.env.S3_REGION) {
    throw new BackupStoreConfigError('s3', ['S3_ENDPOINT 或 S3_REGION'],
      '非 AWS 的 S3 兼容存储必须给 S3_ENDPOINT；AWS S3 必须给 S3_REGION。')
  }

  // 动态 import：没选 s3 时不把 SDK 拉进运行时
  const client = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' } : {}),
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  }))

  return {
    driver: 's3',
    async upload(localPath, objectPath) {
      const [{ PutObjectCommand }, c] = await Promise.all([import('@aws-sdk/client-s3'), client])
      const s = await stat(localPath)
      await c.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: objectPath,
        Body: createReadStream(localPath),
        ContentType: 'application/gzip',
        ContentLength: s.size,
      }))
      return { sizeBytes: s.size }
    },
    async remove(objectPath) {
      const [{ DeleteObjectCommand }, c] = await Promise.all([import('@aws-sdk/client-s3'), client])
      await c.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: objectPath }))
    },
    async download(objectPath, ttlMs) {
      const [{ GetObjectCommand }, { getSignedUrl }, c] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
        client,
      ])
      const url = await getSignedUrl(
        c,
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectPath }),
        { expiresIn: Math.round(ttlMs / 1000) },
      )
      return { kind: 'url', url }
    },
    describe: () => `s3(${endpoint ?? `aws:${region}`}/${env.S3_BUCKET})`,
  }
}

// ── gcs（遗留兼容）───────────────────────────────────────────────────────────

function gcsStore(): BackupStore {
  const bucketName = process.env.GCS_BACKUP_BUCKET_NAME
  if (!bucketName) {
    throw new BackupStoreConfigError('gcs', ['GCS_BACKUP_BUCKET_NAME'],
      '注意：gcs 是遗留 driver，迁到自有服务器后不可用，新环境请改用 BACKUP_DRIVER=s3 或 local。')
  }
  const bucket = import('@google-cloud/storage').then(({ Storage }) => new Storage().bucket(bucketName))

  return {
    driver: 'gcs',
    async upload(localPath, objectPath) {
      const b = await bucket
      await b.upload(localPath, { destination: objectPath, metadata: { contentType: 'application/gzip' } })
      const [metadata] = await b.file(objectPath).getMetadata()
      return { sizeBytes: Number(metadata.size ?? 0) }
    },
    async remove(objectPath) {
      const b = await bucket
      await b.file(objectPath).delete({ ignoreNotFound: true })
    },
    async download(objectPath, ttlMs) {
      const b = await bucket
      const [url] = await b.file(objectPath).getSignedUrl({ action: 'read', expires: Date.now() + ttlMs })
      return { kind: 'url', url }
    },
    describe: () => `gcs(${bucketName})`,
  }
}

// ── 选择 ────────────────────────────────────────────────────────────────────

/** 纯函数，便于单测：把 BACKUP_DRIVER 的原始值规整成 driver 名 */
export function resolveDriverName(raw: string | undefined): BackupDriverName {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 's3' || v === 'local' || v === 'gcs') return v
  if (v === '') return 'local'
  throw new Error(`BACKUP_DRIVER 只能是 local / s3 / gcs，收到 "${raw}"`)
}

let _store: BackupStore | null = null

export function getBackupStore(): BackupStore {
  if (_store) return _store
  const name = resolveDriverName(process.env.BACKUP_DRIVER)
  _store = name === 's3' ? s3Store() : name === 'gcs' ? gcsStore() : localStore()
  return _store
}

/** 仅供测试重置缓存 */
export function __resetBackupStore(): void {
  _store = null
}
