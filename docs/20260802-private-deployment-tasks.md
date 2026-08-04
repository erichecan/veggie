# 私有化部署迁移 —— 任务台账

> **给执行者：** 用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐条执行。
> 步骤用 `- [ ]` 勾选框跟踪。
>
> **本台账是进度的唯一真相，对话不是。**（CLAUDE.md 第十四节）
> 每个周期：读台账 → 取第一个未完成 → 做 → 验证 → 提交 → **回写状态并附 commit hash** → 下一条。
>
> 设计文档：`docs/20260802-private-deployment-migration-design.md`（commit d8b6e72）

**目标：** 把 veggie 从 Cloud Run + Neon 整体迁到客户自有的 DigitalOcean droplet，
应用与数据库全部落在客户服务器上，不留任何云厂商专有依赖。

**架构：** Nginx（宿主机）→ Next.js standalone（Docker，只绑 127.0.0.1:3000）→ PostgreSQL 17
（宿主机 apt，`listen_addresses=''` 只走 unix socket）。镜像由 GitHub Actions 构建推 GHCR，
服务器 pull 部署。

**技术栈：** Next.js 16.2.3 · Prisma 7.7.0 · PostgreSQL 17.10 · Docker Compose · Nginx + certbot ·
GHCR · systemd timer

---

## 全局约束

以下要求对**每一条任务**都生效，不再逐条重复：

- ⛔ **不得新增任何 GCP 专有服务依赖**，不得为跑通功能开通新云资源（CLAUDE.md 部署铁律）
- ⛔ **不得删除或改动 Neon 分支的代码路径**。回滚窗口内 Cloud Run 还在跑，
  「为 Neon 写的迁就现在不要去掉」是铁律明文
- ⛔ 不允许 `any`；数据库操作统一在 `lib/` 下；每个页面文件不超过 150 行
- **本项目 Next.js 为 16.2.3**，`AGENTS.md` 要求动代码前先读 `node_modules/next/dist/docs/`
  下的相关指南，不要按训练数据里的 Next.js 惯例写
- 测试用 `node --test --import=tsx tests/*.test.ts`（即 `npm test`），断言用 `node:assert/strict`
- 新模块的 driver 选择语义**必须与 `lib/storage/backup-store.ts` 一致**：
  未配置默认最保守的那个、大小写空格不敏感、**拼错的值直接抛错不静默回退**
- 每条任务结束必须 `npm run typecheck && npm test && npm run build` 三绿才算完成
- 提交信息写清根因与证据，不写 "fix bug"

---

## 阻塞项看板

| # | 需要什么 | 来自谁 | 阻塞 | 状态 |
|---|---|---|---|---|
| B1 | **子域名** + 客户 DNS A 记录 → `167.99.86.19` | 客户 | T2.6 TLS、阶段 5 | ⛔ **未定** |
| B2 | GitHub 仓库 owner 名（GHCR 路径） | 用户 | 阶段 3 | ⏳ 待确认 |
| B3 | DO Spaces 桶 + 4 个 `S3_*` 凭据 | 用户 | 阶段 6 | ⏳ 待确认 |
| B4 | PGDG 是否支持 Ubuntu 26.04 | 我方核实 | T2.5 | ⏳ 阶段 2 首件事 |

**阶段 1 不被任何阻塞项挡住。**

---

# 阶段 1：代码解耦（当前阶段）

产出：一份既能连 Neon 也能连标准 PostgreSQL、既能写 GCS 也能写本地磁盘的代码，
并在本机用 docker compose 完整验证过。**不碰客户服务器。**

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/db.ts` | Prisma client 单例 + 驱动选择 | 修改 |
| `lib/storage/object-store.ts` | 上传文件落点 driver 抽象（local/s3/gcs） | 新建 |
| `app/api/upload-image/route.ts` | 商品图上传 | 修改（去 GCS 直连） |
| `app/api/purchase-orders/pdf-extract/route.ts` | 采购单 PDF 存档+识别 | 修改（去 GCS 直连） |
| `tests/db-driver.test.ts` | 锁住驱动选择逻辑 | 新建 |
| `tests/object-store.test.ts` | 锁住落点选择与路径安全 | 新建 |
| `tests/no-direct-cloud-sdk.test.ts` | 静态扫描：禁止绕过抽象层直连云 SDK | 新建 |
| `docker-compose.local-pg.yml` | 本地验证环境（标准 PG + unix socket） | 新建 |

`lib/storage/backup-store.ts` 已完成同类抽象，**不在本阶段改动范围**——但它是
`object-store.ts` 的形状参考，写之前先读一遍。

---

## Task 1.1：`lib/db.ts` 双驱动

**Files:**
- Modify: `lib/db.ts`（全文 21 行，整体重写）
- Create: `tests/db-driver.test.ts`
- Modify: `package.json`（新增依赖）

**Interfaces:**
- Produces: `resolveDatabaseDriver(rawDriver: string | undefined, url: string | undefined): 'neon' | 'pg'`
  —— 纯函数，供测试直接调用，不触发任何连接
- Produces: `prisma`（`PrismaClient` 单例，导出名与签名不变，全项目 ~200 处引用不受影响）

---

- [ ] **Step 1: 装依赖并确认 `pg` 是否需要显式安装**

```bash
npm install @prisma/adapter-pg@^7.7.0
npm ls pg
```

`@prisma/adapter-pg` 可能把 `pg` 作为自身依赖带进来。若 `npm ls pg` 显示
`(empty)` 或未找到，再补：

```bash
npm install pg && npm install -D @types/pg
```

若已随 adapter 带入，**不要重复声明**——多一个直接依赖就多一处版本漂移点。

- [ ] **Step 2: 写失败的测试**

创建 `tests/db-driver.test.ts`：

```ts
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
import { resolveDatabaseDriver } from '../lib/db'

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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx tsx --test tests/db-driver.test.ts`
Expected: FAIL —— `resolveDatabaseDriver is not exported` / 模块解析错误

- [ ] **Step 4: 重写 `lib/db.ts`**

```ts
/**
 * Prisma client 单例 + 驱动选择
 * ============================================================================
 * 按项目部署铁律，GCP + Neon 只是临时宿主，功能做完要整体迁到客户自有的
 * DigitalOcean 服务器，数据库也一并迁离 Neon 改为标准 PostgreSQL。
 *
 * 原本这里写死 `PrismaNeon` + `@neondatabase/serverless`（WebSocket 协议），
 * 连不上标准 PostgreSQL —— 这是私有化的第一道门。
 *
 * 两个 driver 由 `DATABASE_DRIVER` 选，未指定时按连接串推断：
 *
 *   neon —— Neon serverless（WebSocket）。**回滚窗口内 Cloud Run 仍在用，不要删。**
 *   pg   —— 标准 PostgreSQL（libpq/TCP 或 unix socket）。迁移后的目标形态。
 *
 * 私有化下的连接串走 unix socket，数据库可配 `listen_addresses=''` 完全不监听网络：
 *   postgresql://veggie@localhost/veggie?host=/var/run/postgresql
 */
import { PrismaClient } from './generated/prisma/client'

export type DatabaseDriverName = 'neon' | 'pg'

/** 纯函数，便于单测：决定用哪个 driver，不触发任何连接 */
export function resolveDatabaseDriver(
  rawDriver: string | undefined,
  url: string | undefined,
): DatabaseDriverName {
  const v = (rawDriver ?? '').trim().toLowerCase()
  if (v === 'neon' || v === 'pg') return v
  if (v !== '') {
    throw new Error(`DATABASE_DRIVER 只能是 neon / pg，收到 "${rawDriver}"`)
  }
  if (!url) {
    throw new Error('DATABASE_URL 未设置，无法推断数据库驱动')
  }
  return url.includes('neon.tech') ? 'neon' : 'pg'
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL!
  const driver = resolveDatabaseDriver(process.env.DATABASE_DRIVER, connectionString)

  if (driver === 'neon') {
    // 同步 require 形态会把 ws 打进所有环境的产物；这里保持顶层 import 的原行为，
    // 但只在 neon 分支才真正构造 adapter。
    const { neonConfig } = require('@neondatabase/serverless') as typeof import('@neondatabase/serverless')
    const { PrismaNeon } = require('@prisma/adapter-neon') as typeof import('@prisma/adapter-neon')
    const ws = require('ws')
    neonConfig.webSocketConstructor = ws
    // PrismaNeon expects a PoolConfig (connection config), not a Pool instance
    return new PrismaClient({ adapter: new PrismaNeon({ connectionString }) })
  }

  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

⚠️ **`require` 在 ESM 下的可用性必须实测**。Next.js 的服务端产物是 CJS/ESM 混合，
若 `require` 不可用（`require is not defined`），改用**顶层 import 全部四个包 + 分支里只构造对应 adapter**
的写法——多打包一点体积，但行为确定。**不要为了省体积把驱动选择做成动态 `await import()`**：
`createPrismaClient()` 是同步的，改成 async 会波及全项目 ~200 处 `prisma` 引用。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test tests/db-driver.test.ts`
Expected: 6 个测试全 PASS

- [ ] **Step 6: 确认 Neon 分支没坏（回归）**

```bash
npm run db:validate    # 连的是 .env.local 里的 Neon 生产库
```

Expected: 与改动前输出一致（已知 895 个历史不守恒商品是存量问题，比的是「一致」不是「干净」）

- [ ] **Step 7: 三绿**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 8: 提交**

```bash
git add lib/db.ts tests/db-driver.test.ts package.json package-lock.json
git commit -m "feat(db): 双驱动支持标准 PostgreSQL，私有化的第一道门

lib/db.ts 原本写死 PrismaNeon + @neondatabase/serverless 的 WebSocket 协议，
连不上客户服务器上的标准 PostgreSQL。按 DATABASE_DRIVER 分 neon/pg 两个分支，
未指定时按连接串是否含 neon.tech 推断。

neon 分支原样保留 —— 回滚窗口内 Cloud Run 还要跑，且铁律明文「为 Neon 写的
迁就现在不要去掉」。

选择逻辑抽成纯函数 resolveDatabaseDriver 以便单测：拼错的值直接抛而不是静默
回退成 neon，否则在客户服务器上的表现是启动时 WebSocket 超时，错误信息完全
指不到根因。"
```

---

## Task 1.2：`lib/storage/object-store.ts` 上传落点抽象

**Files:**
- Create: `lib/storage/object-store.ts`
- Create: `tests/object-store.test.ts`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces:
  - `type ObjectStoreDriverName = 'local' | 's3' | 'gcs'`
  - `resolveObjectDriverName(raw: string | undefined): ObjectStoreDriverName`
  - `class ObjectStoreConfigError extends Error`
  - `interface ObjectStore { readonly driver; put(objectPath, body, contentType, meta?): Promise<{url:string}>; remove(objectPath): Promise<void>; describe(): string }`
  - `getObjectStore(): ObjectStore`
  - `__resetObjectStore(): void`（测试用）
  - `assertSafeObjectPath(objectPath: string): string`

**先读 `lib/storage/backup-store.ts` 全文。** 本模块刻意复用它的形状——同样的 driver 枚举风格、
同样的 `ConfigError(缺哪几个环境变量)` 报错、同样的动态 `import()` 延迟加载 SDK。
两个模块解决的是同一类问题，不该长出两套接口语义。

---

- [ ] **Step 1: 写失败的测试**

创建 `tests/object-store.test.ts`：

```ts
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
  // 依赖调用方的自觉 —— 下一个调用点可能就把文件名拼进去了。
  for (const bad of [
    '../etc/passwd',
    'products/../../etc/passwd',
    '/etc/passwd',
    'products/..',
    'products/a\0b',
    '',
  ]) {
    assert.throws(() => assertSafeObjectPath(bad), /objectPath/, `"${bad}" 应被拒绝`)
  }
})

test('assertSafeObjectPath: 正常路径原样返回', () => {
  assert.equal(assertSafeObjectPath('products/1754-abc.jpg'), 'products/1754-abc.jpg')
  assert.equal(assertSafeObjectPath('purchase-docs/1754-abc.pdf'), 'purchase-docs/1754-abc.pdf')
})

test('local: 落盘到 UPLOAD_DIR，返回的是相对 URL 不是绝对 URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veggie-obj-'))
  process.env.STORAGE_DRIVER = 'local'
  process.env.UPLOAD_DIR = dir
  __resetObjectStore()

  const store = getObjectStore()
  const { url } = await store.put('products/x.jpg', Buffer.from('hello'), 'image/jpeg')

  // 相对路径是刻意的：换域名、加 CDN 都不需要改数据库里存的值
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

test('s3 缺凭据时报出具体缺哪几个环境变量，不是 SDK 堆栈', () => {
  process.env.STORAGE_DRIVER = 's3'
  for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k]
  __resetObjectStore()

  assert.throws(
    () => getObjectStore(),
    (err: unknown) => {
      assert.ok(err instanceof ObjectStoreConfigError)
      assert.match((err as Error).message, /S3_BUCKET/)
      assert.match((err as Error).message, /S3_ACCESS_KEY_ID/)
      assert.match((err as Error).message, /S3_SECRET_ACCESS_KEY/)
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test tests/object-store.test.ts`
Expected: FAIL —— `Cannot find module '../lib/storage/object-store'`

- [ ] **Step 3: 实现 `lib/storage/object-store.ts`**

```ts
/**
 * 上传文件落点 —— driver 抽象
 * ============================================================================
 * 与 `lib/storage/backup-store.ts` 是同一类问题的两个实例（备份产物 / 用户上传），
 * 刻意保持相同的接口语义与报错风格，不要在这里发明第二套约定。
 *
 *   local —— 落本地磁盘（默认）。**迁移后的目标形态**：文件由 Nginx alias 直出，
 *            不经 Node 进程；返回的 url 是相对路径，换域名/加 CDN 不用改数据。
 *   s3    —— 任何 S3 兼容对象存储（DigitalOcean Spaces / MinIO / B2 / AWS S3）。
 *   gcs   —— 遗留兼容，仅为让当前 Cloud Run 部署不断。⚠️ 不要在新环境里选它。
 *
 * ⛔ 本模块不会替你开通任何云资源。
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
 * 当前两个调用点的 objectPath 都由 Date.now() + crypto.randomUUID() 拼出，不含用户
 * 输入 —— 但抽象层不能依赖调用方的自觉，下一个调用点可能就把上传文件名拼进去了。
 * local driver 下一次路径穿越就是任意文件写入。
 */
export function assertSafeObjectPath(objectPath: string): string {
  if (!objectPath || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectPath)) {
    throw new Error(`非法 objectPath：${JSON.stringify(objectPath)}`)
  }
  if (objectPath.includes('..') || objectPath.endsWith('/')) {
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
    // 双保险：即使白名单被绕过，resolve 之后仍必须在 root 内
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new Error(`objectPath 解析后逃出了 UPLOAD_DIR：${objectPath}`)
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

// ── s3 兼容 ─────────────────────────────────────────────────────────────────

function s3Store(): ObjectStore {
  const env = requireEnv(
    's3',
    ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    'DigitalOcean Spaces 还需 S3_ENDPOINT（如 https://fra1.digitaloceanspaces.com）与 S3_REGION（如 fra1）；' +
      'AWS S3 只需 S3_REGION。桶需自行创建，本模块不会替你开通。',
  )
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  const publicBase = process.env.S3_PUBLIC_BASE_URL

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

/** 仅供测试重置单例 */
export function __resetObjectStore(): void {
  _store = null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test tests/object-store.test.ts`
Expected: 9 个测试全 PASS

- [ ] **Step 5: 三绿并提交**

```bash
npm run typecheck && npm test && npm run build
git add lib/storage/object-store.ts tests/object-store.test.ts
git commit -m "feat(storage): 上传文件落点抽成 local/s3/gcs 三驱动

upload-image 与 pdf-extract 直连 @google-cloud/storage，并把
https://storage.googleapis.com/... 绝对 URL 写进数据库，与「迁到客户自有
服务器」冲突。本 commit 只加抽象层，调用点改造在下一条。

刻意复用 lib/storage/backup-store.ts 的形状（driver 枚举、ConfigError 报出
缺哪几个变量、动态 import 延迟加载 SDK）—— 两者是同一类问题的两个实例，
不该长出两套接口语义。

local driver 返回相对路径 /uploads/... 而非绝对 URL：换域名、加 CDN 都不用
改数据库里已存的值。

加了 assertSafeObjectPath：当前两个调用点的 objectPath 由 Date.now()+
randomUUID 拼出、不含用户输入，但抽象层不能依赖调用方的自觉——local driver
下一次路径穿越就是任意文件写入。"
```

---

## Task 1.3：改造两个 GCS 调用点 + 静态回归锁

**Files:**
- Modify: `app/api/upload-image/route.ts:1-20, 57-73`
- Modify: `app/api/purchase-orders/pdf-extract/route.ts:1-20, 113-120`
- Create: `tests/no-direct-cloud-sdk.test.ts`

**Interfaces:**
- Consumes: `getObjectStore()` from Task 1.2

---

- [ ] **Step 1: 写静态回归锁测试**

创建 `tests/no-direct-cloud-sdk.test.ts`：

```ts
/**
 * 禁止绕过存储抽象层直连云 SDK。
 *
 * 由来：抽象层做好之后最容易发生的退化，是下一个功能图省事又 import 一次
 * @google-cloud/storage —— 代码能跑、测试全绿，直到迁到客户服务器才炸。
 * 这类回归没有任何运行时测试会红，只能靠静态扫描挡。
 *
 * 与 tests/public-api-routes.test.ts 同一思路：扫全量文件而不是断言一份名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 允许直连云 SDK 的文件——只有抽象层自己 */
const ALLOWED = new Set([
  'lib/storage/object-store.ts',
  'lib/storage/backup-store.ts',
])

const CLOUD_SDKS = ['@google-cloud/storage', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

test('只有 lib/storage/* 可以直连云存储 SDK', () => {
  const offenders: string[] = []
  for (const file of [...walk('app'), ...walk('lib')]) {
    if (ALLOWED.has(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const sdk of CLOUD_SDKS) {
      if (src.includes(sdk)) offenders.push(`${file} → ${sdk}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过了 lib/storage 抽象层直连云 SDK，迁到客户自有服务器后会失效：\n' +
      offenders.join('\n'),
  )
})

test('业务代码不许硬编码 storage.googleapis.com 绝对 URL', () => {
  const offenders: string[] = []
  for (const file of [...walk('app'), ...walk('lib')]) {
    if (ALLOWED.has(file)) continue
    if (readFileSync(file, 'utf8').includes('storage.googleapis.com')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `硬编码 GCS 绝对 URL：\n${offenders.join('\n')}`)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test tests/no-direct-cloud-sdk.test.ts`
Expected: FAIL，列出 `app/api/upload-image/route.ts`、`app/api/purchase-orders/pdf-extract/route.ts`

- [ ] **Step 3: 改造 `app/api/upload-image/route.ts`**

删除第 2 行的 `import { Storage } from '@google-cloud/storage'` 与第 11-19 行的
`_storage` / `getStorage()`，改为：

```ts
import { getObjectStore } from '@/lib/storage/object-store'
```

把原第 57-73 行（`const bucketName = ...` 到 `return NextResponse.json({ url: publicUrl })`）替换为：

```ts
      const buffer = Buffer.from(await file.arrayBuffer())
      const { url } = await getObjectStore().put(objectPath, buffer, file.type, {
        // 追溯上传人，方便后续审计/清理
        uploadedBy: user.userId,
        uploadedByEmail: user.email,
      })
      return NextResponse.json({ url })
```

鉴权（`withAuth` + `ALLOWED_ROLES`）、限流、类型与大小校验**一律不动**。

- [ ] **Step 4: 改造 `app/api/purchase-orders/pdf-extract/route.ts`**

删除第 2 行 import 与第 16-20 行的 `_storage` / `getStorage()`，改为：

```ts
import { getObjectStore } from '@/lib/storage/object-store'
```

把原第 113-120 行替换为：

```ts
      const objectPath = `purchase-docs/${Date.now()}-${crypto.randomUUID()}.pdf`
      const { url: sourceDocumentUrl } = await getObjectStore().put(
        objectPath,
        buffer,
        'application/pdf',
        { uploadedBy: user.userId, uploadedByEmail: user.email },
      )
```

后续所有引用 `sourceDocumentUrl` 的分支（空文字层、AI 成功、AI 失败三处）都不动。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test tests/no-direct-cloud-sdk.test.ts`
Expected: 2 个测试 PASS

- [ ] **Step 6: 功能验证（真跑一次上传，不只看编译过）**

```bash
# 用 local driver 起开发服务
STORAGE_DRIVER=local UPLOAD_DIR=/tmp/veggie-uploads npm run dev
```

另开终端，拿一个有效 token 打真实接口（mint token 的方式见 `docs/20260802-verification-protocol.md`）：

```bash
curl -s -X POST http://localhost:3000/api/upload-image \
  -H "Cookie: token=$TOKEN" -F "file=@public/favicon.ico;type=image/png" | tee /dev/stderr
ls -l /tmp/veggie-uploads/products/
```

Expected: 返回 `{"url":"/uploads/products/<时间戳>-<uuid>.ico"}`，且该文件真的在磁盘上。

再验异常路径：

```bash
# 无 token → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/upload-image
# 超大文件 → 400 且不落盘
# 非法类型 → 400
curl -s -X POST http://localhost:3000/api/upload-image -H "Cookie: token=$TOKEN" \
  -F "file=@package.json;type=application/json"
```

Expected: 401 / 400「仅支持 JPG、PNG、WebP、GIF 格式图片」，且 `/tmp/veggie-uploads` 里没有多余文件。

- [ ] **Step 7: 三绿并提交**

```bash
npm run typecheck && npm test && npm run build
git add app/api/upload-image/route.ts app/api/purchase-orders/pdf-extract/route.ts tests/no-direct-cloud-sdk.test.ts
git commit -m "refactor(storage): 两个上传路由改走 object-store，去掉 GCS 直连

app/api/upload-image 与 app/api/purchase-orders/pdf-extract 是仅剩的两处
直连 @google-cloud/storage 的业务代码。改走 lib/storage/object-store 后，
私有化下 STORAGE_DRIVER=local 即可，无需任何云资源。

鉴权、限流、类型与大小校验一律未动，只替换存储调用与 URL 生成。

加 tests/no-direct-cloud-sdk.test.ts 静态扫 app/ 与 lib/：抽象层做好之后
最容易发生的退化是下一个功能图省事又 import 一次 SDK——代码能跑、测试全绿，
直到迁到客户服务器才炸。这类回归没有任何运行时测试会红，只能靠静态扫描挡。
（同 tests/public-api-routes.test.ts 的思路：扫全量而不是断言一份名单）"
```

---

## Task 1.4：本地 docker compose 全链路验证（⛔ 硬关卡）

**Files:**
- Create: `docker-compose.local-pg.yml`
- Create: `docs/20260802-local-pg-verification.md`（验证记录，含实测输出）

**这是阶段 1 的出口关卡。** 驱动切换的所有问题必须在自己机器上暴露完，
不拿客户服务器当试错环境。

设计文档 §2.2 标记的最高风险项是 **unix socket 的容器内权限**：
容器里的 `nextjs`(uid 1001) 要能读 PostgreSQL 的 socket。本地用两个容器共享一个
命名卷来复现这个问题——与服务器上「容器挂宿主机 socket 目录」不完全相同，但
**权限与 gid 这一层是同一个问题**，能提前暴露。

---

- [ ] **Step 1: 写 `docker-compose.local-pg.yml`**

```yaml
# 本地验证专用：标准 PostgreSQL 17 + unix socket + 本地磁盘存储。
# 目的是在自己机器上暴露驱动切换的问题，不是生产编排文件。
# 生产编排在阶段 3 另写（PostgreSQL 装宿主机，不在 compose 里）。
name: veggie-local-pg

services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: veggie
      POSTGRES_PASSWORD: localonly
      POSTGRES_DB: veggie
    command:
      - postgres
      - -c
      - listen_addresses=          # 不监听网络，只走 socket——与服务器一致
      - -c
      - shared_buffers=256MB
      - -c
      - random_page_cost=1.1
    volumes:
      - pgdata:/var/lib/postgresql/data
      - pgsock:/var/run/postgresql   # 与 app 共享
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U veggie -h /var/run/postgresql"]
      interval: 3s
      timeout: 3s
      retries: 20

  app:
    build: .
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_DRIVER: pg
      DATABASE_URL: postgresql://veggie@localhost/veggie?host=/var/run/postgresql
      STORAGE_DRIVER: local
      UPLOAD_DIR: /data/uploads
      BACKUP_DRIVER: local
      BACKUP_LOCAL_DIR: /data/backups
      JWT_SECRET: local-verification-only-not-a-real-secret
      NODE_ENV: production
    volumes:
      - pgsock:/var/run/postgresql
      - uploads:/data/uploads
      - backups:/data/backups
    ports:
      - "127.0.0.1:3100:3000"

volumes:
  pgdata:
  pgsock:
  uploads:
  backups:
```

- [ ] **Step 2: 起环境并解决 socket 权限**

```bash
docker compose -f docker-compose.local-pg.yml up -d --build
docker compose -f docker-compose.local-pg.yml logs -f app
```

**预期这一步会失败**，报 socket 权限或连接被拒。这正是要提前暴露的问题。
排查顺序：

```bash
# 看 socket 的属主与权限
docker compose -f docker-compose.local-pg.yml exec db ls -ln /var/run/postgresql
# 看 app 容器里的 uid/gid
docker compose -f docker-compose.local-pg.yml exec app id
```

修法（按优先级）：给 app 服务加 `group_add:` 匹配 postgres 的 gid；
或在 Dockerfile 里把 `nextjs` 用户加进对应 gid。
**把最终修法和原因写进 `docs/20260802-local-pg-verification.md`**——
服务器上会再撞一次同样的问题，那时要能直接照做。

⛔ 若连续 2 次没修好，停下来问用户，不要试第 3 次（CLAUDE.md 第十四节硬停止条件）。

- [ ] **Step 3: 建表并灌种子数据**

```bash
docker compose -f docker-compose.local-pg.yml exec app npx prisma migrate deploy
docker compose -f docker-compose.local-pg.yml exec app npx tsx prisma/seed.ts
```

> 用 `npx tsx prisma/seed.ts` 而不是 `npx prisma db seed`：后者最终也是跑这条
> （`package.json` 的 `prisma.seed`），但多绕一层 CLI，容器里没必要。
> 种子脚本已在 T1.3b 改走 `lib/prisma-factory`，`DATABASE_DRIVER=pg` 对它生效。

Expected: 61 个迁移全部 applied；种子数据落库。

- [ ] **Step 4: 跑完整业务闭环**

按 `docs/20260802-verification-protocol.md` 的协议，对 `http://localhost:3100` 逐条走通：

```
登录 → 下单 → 确认（扣库存）→ 拣货波次 → 派车 → 确认出发
→ 司机手写电子签收 → 生成发票 → 打印 6 类单据（必须验中文字体不乱码）
→ 财务确认交账 → 触发一次备份 → 从备份恢复到临时库
```

每一步记录：请求、HTTP 状态、关键响应字段。**打印 PDF 那步必须真下载下来看**——
中文字体缺失在 200 响应里看不出来（20260715 就是这么漏掉的）。

- [ ] **Step 5: 异常路径验证**

```bash
# 未登录访问受保护页 → 跳登录页，不是 500
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/orders
# 错误密码 → 提示，不崩溃
curl -s -X POST http://localhost:3100/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"nope@test.com","password":"wrong"}'
# 不存在的资源 → 404，不是空白
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/orders/nonexistent-id
```

- [ ] **Step 6: 日志检查**

```bash
docker compose -f docker-compose.local-pg.yml logs app | grep -iE "error|exception|failed|warn"
```

有任何 error 级别日志，必须修复后重跑，不能带着走。

- [ ] **Step 7: 写验证记录并提交**

`docs/20260802-local-pg-verification.md` 必须包含：
socket 权限问题的实际现象与修法 · 闭环每一步的实测输出 ·
Prisma 7 adapter-pg 与 adapter-neon 的行为差异（如有）· 未解决的问题（如有，同时回写本台账）

```bash
docker compose -f docker-compose.local-pg.yml down -v
git add docker-compose.local-pg.yml docs/20260802-local-pg-verification.md
git commit -m "test: 本地 compose 跑通标准 PG + unix socket + 本地磁盘存储全链路

阶段 1 的出口关卡。驱动切换的问题必须在自己机器上暴露完，不拿客户服务器
当试错环境。

[此处补充实际暴露出的问题与修法]"
```

---

## 阶段 1 完成判据

全部满足才能进阶段 2：

- [ ] `npm run typecheck && npm test && npm run build` 三绿
- [ ] `tests/db-driver.test.ts`、`tests/object-store.test.ts`、`tests/no-direct-cloud-sdk.test.ts` 全绿
- [ ] `npm run db:validate` 连 Neon 的结果与改动前一致（Neon 分支未坏）
- [ ] 本地 compose 下完整业务闭环跑通，含 PDF 中文字体、手写签收、备份与恢复
- [ ] 异常路径（401/400/404）行为正确，无 500
- [ ] 容器日志无 error 级别条目
- [ ] `docs/20260802-local-pg-verification.md` 已记录 socket 权限问题的实际修法

---

# 阶段 2–7（服务器侧，待前置解除后展开）

> 这些任务依赖服务器实况与阻塞项，现在写详细步骤会写出对不上的东西。
> **每条的验收标准现在就定死**，具体步骤在进入该阶段时展开（届时人已在服务器上，能看到真实输出）。

## 阶段 2：服务器基线

| # | 任务 | 验收标准 | 依赖 |
|---|---|---|---|
| T2.0 | 核实 PGDG 是否支持 Ubuntu 26.04 | `apt-cache policy postgresql-17` 能查到候选版本；查不到则记录退路（官方容器镜像）并告知用户 | B4 |
| T2.1 | 加 2 GB swap，`vm.swappiness=10` | `free -h` 显示 swap 2G；`sysctl vm.swappiness` 为 10；**重启后仍在**（写进 `/etc/fstab` 与 `sysctl.d`） | 无 |
| T2.2 | 时区设 `Europe/Dublin` | `timedatectl` 显示 Europe/Dublin | 无 |
| T2.3 | 装 Docker Engine + compose plugin | `docker compose version` 有输出；`docker run --rm hello-world` 成功 | 无 |
| T2.4 | 建 `veggie`/`deploy` 用户与 `/data/veggie/{uploads,backups}`、`/opt/veggie`、`/etc/veggie` | `namei -l` 逐级核对属主与权限符合设计 §2 图；`deploy` 用户**不能**读 `/etc/veggie/app.env` 以外的敏感文件 | 无 |
| T2.5 | 装 PostgreSQL 17，建 `veggie` 角色与库，应用调优参数 | `psql -c 'select version()'` 为 17.x；`show shared_buffers` = 1GB；`show random_page_cost` = 1.1；**`ss -tulnp` 中无 5432** | T2.0 |
| T2.6 | 装 Nginx + certbot，签发证书，配自动续期 | `curl -I https://<域名>` 返回 200 且证书有效；`certbot renew --dry-run` 通过 | ⛔ B1 |
| T2.7 | ufw 复核；容器只绑 127.0.0.1 | 从外部机器 `nmap` 只见 2200/80/443 | T2.3 T2.5 |
| T2.8 | 内存/磁盘告警 | **手工触发一次告警并确认收到**（不是配完就算） | 无 |
| T2.9 | 产出《服务器基线配置记录》 | 文档能让另一个人从空机器复现出同样的基线 | T2.1–T2.8 |

## 阶段 3：部署流水线

| # | 任务 | 验收标准 | 依赖 |
|---|---|---|---|
| T3.1 | 新建 `deploy` 专用 SSH 密钥对，公钥装服务器，私钥进 GitHub Secrets | 用该密钥能 ssh 登录并操作 `/opt/veggie`；**不能**用它拿到全量 sudo | T2.4 |
| T3.2 | 写生产 `docker-compose.yml` + `/etc/veggie/app.env`（600） | `docker compose up -d` 起得来，`curl localhost:3000/api/health` 200 | T2.5 阶段 1 |
| T3.3 | 写 `.github/workflows/deploy-droplet.yml`（build → GHCR → ssh 部署） | 一次 `workflow_dispatch` 能把新镜像部署上去并健康检查通过 | B2 T3.1 T3.2 |
| T3.4 | 写 `/opt/veggie/healthcheck.sh` 与回滚逻辑 | **故意部署一个坏镜像**，验证自动回滚到上一个 sha 且服务未中断 | T3.3 |
| T3.5 | `deploy.yml`（Cloud Run）改为仅手动触发 | push main 不再触发 Cloud Run 部署 | T3.3 |
| T3.6 | systemd timer 触发备份 cron 路由 | `systemctl list-timers` 可见；手工 `systemctl start` 一次，备份产物真实生成 | T3.2 |

## 阶段 4：演练迁移

| # | 任务 | 验收标准 |
|---|---|---|
| T4.1 | droplet 上 `pg_dump -Fc` 拉 Neon 生产库 | dump 文件生成，`pg_restore -l` 能列出对象清单；**记录耗时** |
| T4.2 | `pg_restore -j2` 到本地 PG | 退出码 0；warning 逐条看过并判定可忽略；**记录耗时** |
| T4.3 | 逐表行数比对脚本 | **零差异**。任一张表对不上就停，不进下一步 |
| T4.4 | `prisma migrate status` | 61 个迁移全 applied，无 pending、无 failed |
| T4.5 | `npm run db:validate` | 结果与 Neon 端**一致**（不是「干净」——895 个历史不守恒商品是存量问题） |
| T4.6 | 完整业务闭环 + 异常路径 | 同阶段 1 完成判据，但跑在服务器上 |
| T4.7 | 产出《演练迁移报告》 | 含每步实测耗时 → 这是正式窗口时长的依据，不靠估 |

## 阶段 5：正式切换

| # | 任务 | 验收标准 |
|---|---|---|
| T5.0 | **重跑文件存量计数**（设计 §1.3 的结论有时效性） | 若 `images` 已非空，追加对象拷贝 + URL 订正步骤后再继续 |
| T5.1 | 确认演练后无新增迁移 | `prisma/migrations` 数量与演练时一致，否则复核演练结论 |
| T5.2 | Cloud Run 部署 302 跳转镜像（= 停写点） | 访问旧 `*.run.app` 地址跳转到新域名；旧应用不再接受任何写入 |
| T5.3 | 重做 T4.1–T4.5 | 同上，**零差异**才继续 |
| T5.4 | 切 `app.env` 到本地 PG 并 `up -d` | 应用起来，健康检查通过 |
| T5.5 | 闭环冒烟 | 通过。**任一环节失败 → 立即把 Cloud Run 换回正常镜像，本次窗口作废** |
| T5.6 | 通知客户新地址 | —— |
| T5.7 | 连续观察一周内存峰值 | 未触及 3.8 GB；验证设计 §1 的 2.4–2.7 GB 估算 |

## 阶段 6：备份与恢复

| # | 任务 | 验收标准 | 依赖 |
|---|---|---|---|
| T6.1 | 配 `BACKUP_DRIVER=s3` → DO Spaces | 备份产物真实出现在 Spaces 桶里 | B3 |
| T6.2 | 保留策略 7 日 + 4 周 + 6 月 | 过期产物被真实清理（可用改系统时间或伪造时间戳验证） | T6.1 |
| T6.3 | 上传文件与配置的定期备份 | `/data/veggie/uploads` 打包产物出现在异地 | T6.1 |
| T6.4 | **真实恢复演练** | 从备份恢复出一个可登录、可查历史订单的实例，出具报告。⛔「有备份文件」不等于「备份可恢复」 | T6.1 |

## 阶段 7：交接与清理

| # | 任务 | 验收标准 |
|---|---|---|
| T7.1 | 《服务器部署与运维手册》《备份与恢复操作手册》《系统交接清单》 | 另一个人照文档能独立完成一次部署与一次恢复 |
| T7.2 | 账号交接 | 账号由甲方自己创建或**当场改密**，不是我方建好再"共享" |
| T7.3 | 数据居留书面记录 | 验收文档中记录：服务器在 DO lon1（英国）、客户为爱尔兰实体、EU→UK 跨境传输事实已告知、客户选择沿用该区域 |
| T7.4 | 保修期响应机制书面化 | 合同第十三条：6 个月免费保修，24 小时响应 |
| T7.5 | **回滚窗口结束后**：删 `deploy.yml`、`cloudbuild.yaml`，导出 Neon 最后一份备份并停库 | Cloud Run 服务已删；Neon 备份已异地留存 |
| T7.6 | `next.config.ts` 去云化：CSP 与 `images.remotePatterns` 去掉 `storage.googleapis.com`、`*.neon.tech` | 新域名下页面正常、图片正常、控制台无 CSP 违规 |

> **T7.6 为什么排在最后而不是阶段 1**：设计 §3.3 原本把它放在代码解耦里。
> 但回滚窗口内**同一个镜像要同时服务 Cloud Run 和 droplet**，此时收紧 CSP 只会
> 增加回滚风险，而放宽的 allow-list 条目本身无害。YAGNI：等窗口关闭、
> 确定不再回 Cloud Run 了再收紧。

---

## 进度回写区

> 每完成一条，在这里追加一行（任务号 · 完成时间 · commit hash · 备注）。
> **回写到文件，不是在对话里说一句「做完了」。**

| 任务 | 完成时间 | commit | 备注 |
|---|---|---|---|
| T1.1 双驱动 | 2026-08-02 | `5466ed2` | ✅ pg 分支已在生产库真实验证（149874 单/5479 商品，与 neon 分支一致）。两处偏离计划见下 |
| T1.2 object-store | 2026-08-03 | `37ca22c` | ✅ 10 项测试全绿；typecheck / 全量 175 项测试 / build 三绿。按计划实现，无偏离 |
| T1.3 改造调用点 | 2026-08-03 | `18b807e` | ✅ 真实 HTTP 验证通过（见下）；全量 178 项测试 0 失败；build 通过。顺带查清了两个既有问题 |
| **T1.3b 脚本脱 Neon**（计划外新增） | 2026-08-04 | `c7278f1` | ✅ 62 个脚本/种子统一走 `lib/prisma-factory`；grep 归零 + typecheck + 178 项测试 + build；**真跑 get-admin.ts 两个驱动都通** |

### T1.3b：一条计划里没有的任务，但它挡在 T1.4 前面

**发现经过**：为查 db:validate 崩溃根因，用 `DATABASE_DRIVER=pg` 跑对照，
栈里**仍是** `PrismaNeonAdapter` —— 因为 `scripts/validate-data.ts` 自己
`new PrismaClient({ adapter: new PrismaNeon(...) })`，根本不读 `lib/db`。
实验无效，但顺藤摸出 `scripts/` + `prisma/` 下**62 个文件**都是这个写法。

**为什么必须先做**：`prisma/seed.ts` 就在这份名单里，而 T1.4 第三步要给容器里的
标准 PostgreSQL 灌种子数据 —— 照原样直接连不上。`scripts/validate-data.ts` 同理，
它在阶段 4 的验收判据里。

**改法**：抽 `lib/prisma-factory.ts` 作唯一构造入口（复用 `lib/db-driver` 的选择逻辑），
codemod 机械替换，`lib/db.ts` 退化成只管单例。加第三条静态锁，并用临时违规文件
验证过该锁**不是空转**。

> **给设计文档的修正**：§1.4「代码层耦合点（复查后为 3 处）」是错的，实际是
> **3 处 + 62 个脚本/种子**。清查范围当时只覆盖了 `app/` 和 `lib/`。

### T1.3 实测结果（dev 服务器 + `STORAGE_DRIVER=local`，真实 HTTP 请求）

| 用例 | 结果 |
|---|---|
| upload-image 正常上传 PNG | `{"url":"/uploads/products/<ts>-<uuid>.png"}`，**SHA256 与源文件逐字节一致** |
| pdf-extract 上传 PDF | 落盘 41332 字节到 `purchase-docs/` |
| 两个路由无 token / 伪造 token | 均 401 |
| 非法类型 | 400「仅支持 JPG、PNG、WebP、GIF」/「仅支持 PDF 文件」 |
| 异常路径后目录内容 | 只有正常路径写入的文件，异常路径不落盘 |

### T1.3 查清的两个**既有**问题（非本次引入，均不阻塞）

1. **pdf-extract 在 dev 模式下正常路径返回 500。**
   文件已成功落盘（存储那段是好的），报错在下游 `extractPdfText`：
   `Setting up fake worker failed: Cannot find module '.next/dev/server/chunks/pdf.worker.mjs'`
   —— Turbopack **dev 模式**解析不到 pdfjs 的 worker chunk。生产构建走
   `next.config.ts` 的 `outputFileTracingIncludes`，路径不同。
   **T1.4 的生产镜像必须专门验这条**，若生产也 500 则是真 bug，要单独立项。

2. **`npm run db:validate` 连 Neon 会断连崩溃**（不是慢）。
   跑约 15 分钟后 `Connection terminated unexpectedly`，栈在
   `@neondatabase/serverless` 的 WebSocket 层。属于 CLAUDE.md 记的
   「为 Neon 写的迁就」那一类问题。正在用 `DATABASE_DRIVER=pg`（libpq/TCP）
   重跑做对照——若 pg 能跑完，就同时证明了两件事：崩溃根因是 Neon 的 WebSocket 驱动，
   且迁移之后这个问题自动消失。

### 一个操作教训

首轮验证里 `curl -F "file=@public/favicon.ico"` 全返回 `000`，一度以为是服务端问题。
实际是**该文件不存在**，curl 在本地就失败了，`%{http_code}` 因此是 000。
→ 用 curl 做上传验证时，先确认待上传的样本文件真的存在；`000` 优先怀疑客户端而不是服务端。

### T1.1 与计划的偏离（已在 commit 说明中记录）

1. **纯函数拆到 `lib/db-driver.ts`**，不留在 `lib/db.ts`。后者模块加载即构造 PrismaClient，
   测一个字符串函数要连带加载整个 client，而测试环境无 `DATABASE_URL`。
2. **无连接串时不判定驱动、不抛错**，回落改造前行为。原计划让它抛，结果打死了
   `tests/backup.test.ts` 与 `tests/analytics-shortage-summary.test.ts`——这两个
   **通过传递依赖**（`lib/backup.ts` / `lib/analytics/*`）加载到 `lib/db` 却从不查库。
   写计划时只 grep 了 tests/ 里的直接 import，漏了传递路径。

> 教训（对后续任务有效）：改 `lib/db.ts`、`lib/auth.ts` 这类被广泛间接依赖的模块时，
> 「哪些测试会受影响」不能靠 grep 直接 import 判断，必须真跑一次 `npm test`。

### 意外收获

**Neon 也支持标准 libpq 协议**，所以 `DATABASE_DRIVER=pg` 配 Neon 连接串能直接跑通。
这意味着 pg 分支不必等到 Task 1.4 的 docker compose 才能验证，现在就已在**生产数据**上验过。
阶段 4 演练迁移时也可用这个方式做两端比对。

## 未解决问题

> 显式留一条，不要只在对话里提。

- ~~`npm run db:validate` 连 Neon 跑 15 分钟无输出~~ → **已查清（T1.3）：不是慢，是崩。**
  `Connection terminated unexpectedly`，栈在 `@neondatabase/serverless` 的 WebSocket 层。
  这不是本次改动引入的（走的是未改行为的 neon 分支）。pg 驱动对照实验进行中。
  **若对照证实是 Neon 驱动的问题，则迁移后自动消失**，属于「迁过去就好了」的一类，
  不需要单独修。
- **pdf-extract 生产模式是否也 500** —— dev 模式下因 Turbopack 找不到 pdfjs worker chunk
  而 500（文件已正常落盘，故非存储问题）。**T1.4 生产镜像必须专门验**。
  若生产也 500 → 是真 bug，与本次迁移无关但要单独立项。
- pg 分支配 `sslmode=require` 的 URL 时，`pg-connection-string` 警告未来版本 sslmode
  语义将改变。目标形态走 unix socket 不涉及 SSL，不受影响；仅在阶段 4 用 pg 驱动连
  Neon 做比对时会看到。
