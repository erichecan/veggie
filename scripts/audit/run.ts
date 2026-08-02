/**
 * 探针执行器
 *
 *   npx tsx --env-file=.env.local scripts/audit/run.ts --list
 *   npx tsx --env-file=.env.local scripts/audit/run.ts --module 03
 *   npx tsx --env-file=.env.local scripts/audit/run.ts --id M03-05
 *   npx tsx --env-file=.env.local scripts/audit/run.ts            # 全跑
 *
 * 结果落 docs/audit-evidence/20260802-results.json（累积合并，不覆盖其他模块）
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { allChecks, prisma, type CheckResult } from './harness'
import './checks/index'

const OUT_DIR = 'docs/audit-evidence'
const OUT_FILE = `${OUT_DIR}/20260802-results.json`

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const checks = allChecks()

  if (process.argv.includes('--list')) {
    for (const c of checks) console.log(`${c.id.padEnd(9)} [${c.module}] ${c.title}`)
    console.log(`\n共 ${checks.length} 条`)
    return
  }

  const mod = arg('module')
  const id = arg('id')
  const selected = checks.filter(c =>
    (!mod || c.module === mod) && (!id || c.id === id))

  if (selected.length === 0) {
    console.error('没有匹配的 check')
    process.exitCode = 1
    return
  }

  const results: CheckResult[] = []
  for (const c of selected) {
    process.stdout.write(`▶ ${c.id} ${c.title} ... `)
    try {
      const r = await c.run()
      const full: CheckResult = { id: c.id, module: c.module, title: c.title, prev: c.prev, ...r }
      results.push(full)
      const moved = c.prev && c.prev !== r.verdict ? ` (${c.prev}→${r.verdict})` : ''
      console.log(`${r.verdict}${moved}`)
      for (const e of r.evidence) console.log(`    · ${e}`)
      if (r.gap) console.log(`    ⚠ 缺口: ${r.gap}`)
    } catch (e) {
      console.log('ERROR')
      console.log(`    ✗ ${(e as Error).message}`)
      results.push({
        id: c.id, module: c.module, title: c.title, prev: c.prev,
        verdict: 'missing',
        gap: `探针执行失败: ${(e as Error).message}`,
        evidence: ['探针异常，需人工复核'],
      })
    }
  }

  mkdirSync(OUT_DIR, { recursive: true })
  let merged: Record<string, CheckResult> = {}
  if (existsSync(OUT_FILE)) {
    try { merged = JSON.parse(readFileSync(OUT_FILE, 'utf8')) } catch { merged = {} }
  }
  for (const r of results) merged[r.id] = r
  writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2) + '\n')
  console.log(`\n已写入 ${OUT_FILE}（累计 ${Object.keys(merged).length} 条）`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
