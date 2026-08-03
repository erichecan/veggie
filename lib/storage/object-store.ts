/**
 * 上传文件落点 —— driver 抽象
 * ============================================================================
 * 与 `lib/storage/backup-store.ts` 是同一类问题的两个实例（备份产物 / 用户上传），
 * 刻意保持相同的接口语义与报错风格，不要在这里发明第二套约定。
 *
 * 为什么有这一层：按项目部署铁律，GCP + Neon 只是临时宿主，功能做完要整体迁到
 * 客户自有的 DigitalOcean 服务器。`app/api/upload-image` 与
 * `app/api/purchase-orders/pdf-extract` 原本直连 `@google-cloud/storage`，
 * 还把 `https://storage.googleapis.com/...` 绝对 URL 写进数据库——迁移时既要改
 * 代码，又要改已落库的数据。
 *
 *   local —— 落本地磁盘（默认）。**迁移后的目标形态**：文件由 Nginx alias 直出，
 *            不经 Node 进程；返回的 url 是相对路径，换域名/加 CDN 不用改数据。
 *   s3    —— 任何 S3 兼容对象存储（DigitalOcean Spaces / MinIO / B2 / AWS S3）。
 *   gcs   —— 遗留兼容，仅为让当前 Cloud Run 部署不断。⚠️ 不要在新环境里选它。
 *
 * ⛔ 本模块不会替你开通任何云资源。桶要自己建，缺配置时会明确报出缺哪几个环境
 *    变量，而不是抛一个 SDK 堆栈。
 */
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

export type ObjectStoreDriverName = 'local' | 's3' | 'gcs'

export interface ObjectStore {
  readonly driver: ObjectStoreDriverName
  /** 写入对象，返回可直接存进数据库的公开 URL */
  put(
    objectPath: string,
    body: Buffer,
    contentType: string,
    meta?: Record<string, string>,
  ): Promise<{ url: string }>
  /** 删除；对象不存在不算错 */
  remove(objectPath: string): Promise<void>
  /** 供报错与运维排查用的一行描述，不含任何密钥 */
  describe(): string
}

/** 配置缺失时抛这个，携带该 driver 需要的全部环境变量名 */
export class ObjectStoreConfigError extends Error {
  constructor(driver: ObjectStoreDriverName, missing: string[], hint: string) {
    super(`上传落点未配置完整：STORAGE_DRIVER=${driver} 还缺 ${missing.join('、')}。${hint}`)
    this.name = 'ObjectStoreConfigError'
  }
}

function requireEnv(
  driver: ObjectStoreDriverName,
  names: string[],
  hint: string,
): Record<string, string> {
  const missing = names.filter(n => !process.env[n])
  if (missing.length > 0) throw new ObjectStoreConfigError(driver, missing, hint)
  return Object.fromEntries(names.map(n => [n, process.env[n] as string]))
}

/**
 * objectPath 白名单校验。
 *
 * 当前两个调用点的 objectPath 都由 `Date.now()` + `crypto.randomUUID()` 拼出，不含
 * 用户输入 —— 但抽象层不能依赖调用方的自觉，下一个调用点可能就把上传文件名拼进去
 * 了。local driver 下一次路径穿越就是任意文件写入。
 */
export function assertSafeObjectPath(objectPath: string): string {
  if (
    !objectPath ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectPath) ||
    objectPath.includes('..') ||
    objectPath.endsWith('/')
  ) {
    throw new Error(`非法 objectPath：${JSON.stringify(objectPath)}`)
  }
  return objectPath
}

// ── local ───────────────────────────────────────────────────────────────────

function localStore(): ObjectStore {
  const root = resolve(process.env.UPLOAD_DIR ?? './uploads')
  const prefix = process.env.UPLOAD_URL_PREFIX ?? '/uploads'

  function safeDest(objectPath: string): string {
    const dest = resolve(join(root, assertSafeObjectPath(objectPath)))
    // 双保险：即使白名单被绕过，resolve 之后仍必须在 root 之内
    if (!dest.startsWith(root + sep)) {
      throw new Error(`objectPath 解析后逃出了 UPLOAD_DIR：${JSON.stringify(objectPath)}`)
    }
    return dest
  }

  return {
    driver: 'local',
    async put(objectPath, body) {
      const dest = safeDest(objectPath)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, body)
      return { url: `${prefix}/${objectPath}` }
    },
    async remove(objectPath) {
      await unlink(safeDest(objectPath)).catch(() => {})
    },
    describe: () => `local(${root} → ${prefix})`,
  }
}

// ── s3 兼容（DigitalOcean Spaces / MinIO / B2 / AWS S3）──────────────────────

function s3Store(): ObjectStore {
  const env = requireEnv(
    's3',
    ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    'DigitalOcean Spaces 还需 S3_ENDPOINT（如 https://fra1.digitaloceanspaces.com）与 S3_REGION（如 fra1）；' +
      'AWS S3 只需 S3_REGION。桶需自行创建，本模块不会替你开通。',
  )
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  // 桶挂了 CDN 或自定义域名时用它覆盖默认拼法
  const publicBase = process.env.S3_PUBLIC_BASE_URL

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
    async put(objectPath, body, contentType, meta) {
      assertSafeObjectPath(objectPath)
      const [{ PutObjectCommand }, c] = await Promise.all([import('@aws-sdk/client-s3'), client])
      await c.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: objectPath,
        Body: body,
        ContentType: contentType,
        // 商品图与采购单存档要能被 <img src> 直接读到
        ACL: 'public-read',
        Metadata: meta,
      }))
      const base = publicBase ?? (endpoint
        ? `${endpoint.replace(/\/$/, '')}/${env.S3_BUCKET}`
        : `https://${env.S3_BUCKET}.s3.${region}.amazonaws.com`)
      return { url: `${base}/${objectPath}` }
    },
    async remove(objectPath) {
      const [{ DeleteObjectCommand }, c] = await Promise.all([import('@aws-sdk/client-s3'), client])
      await c.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: objectPath }))
    },
    describe: () => `s3(${endpoint ?? `aws:${region}`}/${env.S3_BUCKET})`,
  }
}

// ── gcs（遗留兼容）───────────────────────────────────────────────────────────

function gcsStore(): ObjectStore {
  const bucketName = process.env.GCS_BUCKET_NAME
  if (!bucketName) {
    throw new ObjectStoreConfigError('gcs', ['GCS_BUCKET_NAME'],
      '注意：gcs 是遗留 driver，迁到自有服务器后不可用，新环境请改用 STORAGE_DRIVER=local 或 s3。')
  }
  const bucket = import('@google-cloud/storage').then(({ Storage }) => new Storage().bucket(bucketName))

  return {
    driver: 'gcs',
    async put(objectPath, body, contentType, meta) {
      assertSafeObjectPath(objectPath)
      const b = await bucket
      await b.file(objectPath).save(body, { contentType, metadata: { metadata: meta } })
      return { url: `https://storage.googleapis.com/${bucketName}/${objectPath}` }
    },
    async remove(objectPath) {
      const b = await bucket
      await b.file(objectPath).delete({ ignoreNotFound: true })
    },
    describe: () => `gcs(${bucketName})`,
  }
}

// ── 选择 ────────────────────────────────────────────────────────────────────

/** 纯函数，便于单测：把 STORAGE_DRIVER 的原始值规整成 driver 名 */
export function resolveObjectDriverName(raw: string | undefined): ObjectStoreDriverName {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 's3' || v === 'local' || v === 'gcs') return v
  if (v === '') return 'local'
  throw new Error(`STORAGE_DRIVER 只能是 local / s3 / gcs，收到 "${raw}"`)
}

let _store: ObjectStore | null = null

export function getObjectStore(): ObjectStore {
  if (_store) return _store
  const name = resolveObjectDriverName(process.env.STORAGE_DRIVER)
  _store = name === 's3' ? s3Store() : name === 'gcs' ? gcsStore() : localStore()
  return _store
}

/** 仅供测试重置缓存 */
export function __resetObjectStore(): void {
  _store = null
}
