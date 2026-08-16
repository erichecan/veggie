/**
 * 驱动包必须按 DATABASE_DRIVER 懒加载（台账 X8）
 * ============================================================================
 * 由来：`docker exec veggie-app-1 npx tsx scripts/audit/xxx.ts` 一律
 * `Cannot find module '@neondatabase/serverless'`，栈顶 lib/prisma-factory.ts。
 * 运行时镜像只有 .next/standalone，它的 node_modules 是 nft 追踪结果，被 webpack
 * 内联掉的驱动包不会留下 —— 于是生产上一个审计脚本都跑不了，而那正是出事时最该
 * 能跑的东西。
 *
 * 这条测试盯的是**运行时真的没去加载它**，不是"源码里看着像懒加载"：
 * 挂 `Module._load` 记下每一次模块请求，走 pg 时 Neon 那三个包一次都不许出现。
 * 只做静态扫源码的话，`const x = await import(...)` 写在函数外、或者哪天有人在
 * 别处补一个顶层 import 又绕回去，扫不出来。
 *
 * ⛔ 改动本文件对应的实现前先想清楚：这是全站唯一的 PrismaClient 构造入口，
 *    改坏了不是某个功能挂，是整个系统连不上库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { createPrismaClient } from '../lib/prisma-factory'

/** 只有真的走 neon 才该被加载的包 */
const NEON_ONLY_PACKAGES = ['@neondatabase/serverless', '@prisma/adapter-neon', 'ws']

const PG_URL = 'postgresql://u:p@127.0.0.1:5432/never_connected'
const NEON_URL = 'postgresql://u:p@ep-fake-000.eu-central-1.aws.neon.tech/never_connected'

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleInternals = Module as unknown as { _load: ModuleLoad }

/**
 * 记录 `createPrismaClient` 期间发起的所有模块请求。
 *
 * 挂 `_load` 而不是看 `require.cache`：`_load` 记的是**请求**，缓存命中也照样经过，
 * 所以不受"上一条测试已经把它加载过了"影响。
 */
function recordModuleRequests(driver: 'pg' | 'neon', connectionString: string): string[] {
  const requested: string[] = []
  const originalLoad = moduleInternals._load
  const originalDriver = process.env.DATABASE_DRIVER

  process.env.DATABASE_DRIVER = driver
  moduleInternals._load = function patchedLoad(request, parent, isMain) {
    requested.push(request)
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const client = createPrismaClient(connectionString)
    // 构造完就丢：本测试全程不连库，只看加载了什么
    assert.ok(client, 'createPrismaClient 应当返回一个 PrismaClient')
  } finally {
    moduleInternals._load = originalLoad
    if (originalDriver === undefined) delete process.env.DATABASE_DRIVER
    else process.env.DATABASE_DRIVER = originalDriver
  }
  return requested
}

test('DATABASE_DRIVER=pg 时一个 Neon 包都不加载（生产容器里裁掉了它们）', () => {
  const requested = recordModuleRequests('pg', PG_URL)

  const leaked = NEON_ONLY_PACKAGES.filter(pkg => requested.includes(pkg))
  assert.deepEqual(
    leaked,
    [],
    '走 pg 却仍然加载了 Neon 驱动包 —— 生产 standalone 产物里没有这些包，' +
      `scripts/audit/ 下所有脚本会直接 MODULE_NOT_FOUND：\n${leaked.join('\n')}`,
  )

  assert.ok(
    requested.includes('@prisma/adapter-pg'),
    'pg 分支应当在被调用时才 require @prisma/adapter-pg；' +
      `实际请求列表：${JSON.stringify(requested)}`,
  )
})

test('DATABASE_DRIVER=neon 时才加载 Neon 驱动（懒加载不等于不加载）', () => {
  const requested = recordModuleRequests('neon', NEON_URL)

  for (const pkg of NEON_ONLY_PACKAGES) {
    assert.ok(
      requested.includes(pkg),
      `neon 分支应当加载 ${pkg}；实际请求列表：${JSON.stringify(requested)}`,
    )
  }
  assert.ok(
    !requested.includes('@prisma/adapter-pg'),
    '走 neon 不该顺手把 pg 适配器也加载了',
  )
})

test('lib/prisma-factory.ts 不许把驱动包写成顶层 import', () => {
  const src = readFileSync(new URL('../lib/prisma-factory.ts', import.meta.url), 'utf8')
  const driverPackages = [...NEON_ONLY_PACKAGES, '@prisma/adapter-pg']

  // 只看以 import 开头的行，注释里提到包名（本文件与实现里都提到了）不算
  const staticImports = src
    .split('\n')
    .filter(line => /^\s*import\b/.test(line))
    .filter(line => driverPackages.some(pkg => line.includes(`'${pkg}'`)))

  assert.deepEqual(
    staticImports,
    [],
    '驱动包被写回顶层 import —— 顶层 import 在模块加载时无条件执行，' +
      '懒加载当场失效，生产容器里的审计脚本会重新全部跑不起来：\n' +
      staticImports.join('\n'),
  )
})
