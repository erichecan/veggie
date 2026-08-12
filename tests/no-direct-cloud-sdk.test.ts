/**
 * 禁止绕过存储抽象层直连云 SDK。
 *
 * 由来：抽象层做好之后最容易发生的退化，是下一个功能图省事又 import 一次
 * @google-cloud/storage —— 代码能跑、测试全绿，直到迁到客户自有服务器才炸。
 * 这类回归没有任何运行时测试会红，只能靠静态扫描挡。
 *
 * 与 tests/public-api-routes.test.ts 同一思路：扫全量文件而不是断言一份名单，
 * 这样新写的文件违规时测试会自己变红，不需要有人记得来更新名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 允许直连云 SDK 的文件 —— 只有抽象层自己 */
const ALLOWED = new Set([
  'lib/storage/object-store.ts',
  'lib/storage/backup-store.ts',
])

const CLOUD_SDKS = [
  '@google-cloud/storage',
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
]

/** Prisma 生成产物，4MB 且不是我们写的代码 */
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function sourceFiles(): string[] {
  return [...walk('app'), ...walk('lib')]
}

test('扫描逻辑本身没坏（能扫到足够多的文件）', () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, `只扫到 ${files.length} 个文件，扫描逻辑可能坏了`)
  assert.ok(files.includes('lib/storage/object-store.ts'))
})

/**
 * 判定「真的依赖了这个 SDK」而不是「文中提到过这个名字」。
 * 只看 import / require / 动态 import —— 注释里写「本文件**不**直连 @google-cloud/storage」
 * 会被 includes() 判成违规（F2 周期实际撞到：一句说明性注释把这条守卫弄红了）。
 * 收紧成语法级匹配比放宽名单更安全：真违规一定出现在这三种形式里。
 */
function importsPackage(src: string, pkg: string): boolean {
  const esc = pkg.replace(/[/@-]/g, m => `\\${m}`)
  return new RegExp(`from\\s*['"]${esc}['"]`).test(src)
    || new RegExp(`require\\(\\s*['"]${esc}['"]`).test(src)
    || new RegExp(`import\\(\\s*['"]${esc}['"]`).test(src)
}

test('只有 lib/storage/* 可以直连云存储 SDK', () => {
  const offenders: string[] = []
  for (const file of sourceFiles()) {
    if (ALLOWED.has(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const sdk of CLOUD_SDKS) {
      if (importsPackage(src, sdk)) offenders.push(`${file} → ${sdk}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过了 lib/storage 抽象层直连云 SDK，迁到客户自有服务器后会失效：\n' +
      offenders.join('\n'),
  )
})

/**
 * 只有 lib/prisma-factory.ts 可以构造 PrismaClient。
 *
 * 由来：2026-08-03 发现 lib/db.ts 改成双驱动之后，scripts/ 与 prisma/ 下还有 62 个
 * 文件各自 `new PrismaClient({ adapter: new PrismaNeon(...) })`，完全绕过 lib/db。
 * 其中包括 prisma/seed.ts —— 迁移演练建完表就没法灌种子数据。设计文档最初的耦合点
 * 清查只看了 app/ 和 lib/，漏了这一整片。
 *
 * 全量 sweep 之后加这条锁：下一个脚本再手搓一个 PrismaNeon，测试立刻变红。
 */
test('只有 lib/prisma-factory.ts 可以直接构造 PrismaClient / 适配器', () => {
  const ALLOWED_FACTORY = new Set(['lib/prisma-factory.ts'])
  // scripts/audit/checks/* 里这些名字是被审计的字符串字面量，不是真的构造
  const AUDIT_CHECKS = /^scripts\/audit\/checks\//
  const offenders: string[] = []
  for (const file of [...sourceFiles(), ...walk('scripts'), ...walk('prisma')]) {
    if (ALLOWED_FACTORY.has(file) || AUDIT_CHECKS.test(file)) continue
    const src = readFileSync(file, 'utf8')
    if (/new\s+PrismaNeon\(/.test(src) || /new\s+PrismaPg\(/.test(src)) {
      offenders.push(`${file} → 直接 new 适配器`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过 lib/prisma-factory 直接构造数据库适配器，迁到标准 PostgreSQL 后连不上：\n' +
      offenders.join('\n'),
  )
})

test('业务代码不许硬编码 storage.googleapis.com 绝对 URL', () => {
  // 绝对 URL 一旦写进数据库，迁移时就不只是改代码，还要订正数据。
  const offenders: string[] = []
  for (const file of sourceFiles()) {
    if (ALLOWED.has(file)) continue
    if (readFileSync(file, 'utf8').includes('storage.googleapis.com')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `硬编码 GCS 绝对 URL：\n${offenders.join('\n')}`)
})

test('守卫本身有效：抓真 import、放过注释里的提及', () => {
  const real = `import { Storage } from '@google-cloud/storage'`
  const mention = `// 本文件不直连 @google-cloud/storage，走 lib/storage 抽象`
  assert.equal(importsPackage(real, '@google-cloud/storage'), true, '真 import 必须被抓到')
  assert.equal(importsPackage(mention, '@google-cloud/storage'), false, '注释提及不算违规')
  assert.equal(importsPackage(`const s = require("@aws-sdk/client-s3")`, '@aws-sdk/client-s3'), true)
})
