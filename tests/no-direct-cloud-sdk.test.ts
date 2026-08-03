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

test('只有 lib/storage/* 可以直连云存储 SDK', () => {
  const offenders: string[] = []
  for (const file of sourceFiles()) {
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
  // 绝对 URL 一旦写进数据库，迁移时就不只是改代码，还要订正数据。
  const offenders: string[] = []
  for (const file of sourceFiles()) {
    if (ALLOWED.has(file)) continue
    if (readFileSync(file, 'utf8').includes('storage.googleapis.com')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `硬编码 GCS 绝对 URL：\n${offenders.join('\n')}`)
})
