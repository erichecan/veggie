/**
 * T5：把 handler 的 `allowedRoles` 改写成权限点要求。
 * ============================================================================
 *   withAuth(req, h, ['OPERATOR','BOSS'])  →  withAuth(req, h, { require: 'x.y.z' })
 *
 * ⛔ 为什么不用正则批量替换：8/6 那次的批量脚本把角色数组插进了注释里 ——
 * 语法合法、tsc 与测试全绿，但那道闸根本不存在，只能整批回滚重做。
 * 所以这里：
 *   1. 定位靠 `lib/route-gate-scan.ts` 的括号配平（会跳过注释、字符串、模板串）
 *   2. 只替换第三个实参那一段，不碰其它字符
 *   3. 改完**回扫验证**：重新 scan 一遍，确认每个目标 handler 的 gate 确实变成了
 *      预期的权限点。不回扫的话，「编译通过」什么都证明不了。
 *
 * 用法：
 *   npx tsx scripts/rbac/migrate-route-gates.ts --dry            看会改什么
 *   npx tsx scripts/rbac/migrate-route-gates.ts --domain orders  只改一个域
 *   npx tsx scripts/rbac/migrate-route-gates.ts                  全改
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { scanApiHandlers } from '../../lib/route-gate-scan'
import { API_ROUTE_RULES, requiredPermissionsFor } from '../../lib/rbac/route-map'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const domainIdx = args.indexOf('--domain')
const onlyDomain = domainIdx >= 0 ? args[domainIdx + 1] : null

const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

// ── 与扫描器同款的括号配平（跳过注释与字符串）────────────────────────────
function skipNonCode(src: string, i: number): number {
  const c = src[i]
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return nl === -1 ? src.length : nl
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2)
    return end === -1 ? src.length : end + 2
  }
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue }
      if (src[j] === c) return j + 1
    }
    return src.length
  }
  return i
}

function matchParen(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) { i = skipped; continue }
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return i }
    i++
  }
  return -1
}

/** 返回第三个实参在 src 里的 [start, end)。找不到返回 null */
function thirdArgRange(src: string, open: number, close: number): [number, number] | null {
  let depth = 0
  let i = open + 1
  let argIdx = 0
  let start = open + 1
  while (i < close) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) { i = skipped; continue }
    const c = src[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      argIdx++
      if (argIdx === 2) start = i + 1
      else if (argIdx === 3) return [start, i]
    }
    i++
  }
  return argIdx >= 2 ? [start, close] : null
}

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

interface Plan {
  file: string
  route: string
  verb: string
  from: string
  to: string
  permissions: string[]
}

const plans: Plan[] = []
const skipped: string[] = []

for (const h of scanApiHandlers()) {
  if (h.gate.kind !== 'roles') continue
  const domain = h.route.split('/')[2] ?? ''
  if (onlyDomain && domain !== onlyDomain) continue

  const required = requiredPermissionsFor(API_ROUTE_RULES, fillParams(h.route), h.verb)
  if (!required || required.length === 0) {
    skipped.push(`${h.verb} ${h.route}：route-map 未要求权限（无需闸门）`)
    continue
  }

  const src = readFileSync(h.file, 'utf8')
  const m = src.match(new RegExp(`export async function ${h.verb}\\s*\\(`))
  if (!m || m.index === undefined) { skipped.push(`${h.verb} ${h.route}：找不到 handler`); continue }

  const after = src.slice(m.index + m[0].length)
  const nextIdx = after.search(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/)
  const body = nextIdx === -1 ? after : after.slice(0, nextIdx)
  const wIdx = body.search(/\bwithAuth(?:Cached)?\(|\bwithCachedAuth\(/)
  if (wIdx === -1) { skipped.push(`${h.verb} ${h.route}：没有 withAuth`); continue }

  const abs = m.index + m[0].length + wIdx
  const open = src.indexOf('(', abs)
  const close = matchParen(src, open)
  if (close === -1) { skipped.push(`${h.verb} ${h.route}：括号不配平`); continue }

  const range = thirdArgRange(src, open, close)
  if (!range) { skipped.push(`${h.verb} ${h.route}：定位不到第三个实参`); continue }

  const literal =
    required.length === 1
      ? `{ require: '${required[0]}' }`
      : `{ require: [${required.map((p) => `'${p}'`).join(', ')}] }`

  plans.push({
    file: h.file,
    route: h.route,
    verb: h.verb,
    from: src.slice(range[0], range[1]).trim(),
    to: literal,
    permissions: [...required],
  })
}

console.log(`待改写 ${plans.length} 处${onlyDomain ? `（域：${onlyDomain}）` : ''}`)
for (const p of plans.slice(0, dryRun ? 999 : 8)) {
  console.log(`  ${p.verb.padEnd(6)} ${p.route.padEnd(45)} ${p.from}  →  ${p.to}`)
}
if (!dryRun && plans.length > 8) console.log(`  … 其余 ${plans.length - 8} 处`)
if (skipped.length > 0) {
  console.log(`\n跳过 ${skipped.length} 处：`)
  skipped.forEach((s) => console.log('  ' + s))
}

if (dryRun) process.exit(0)

// ── 逐文件改写。同一文件里多个 handler 时从后往前改，避免下标错位 ────────
const byFile = new Map<string, Plan[]>()
for (const p of plans) {
  if (!byFile.has(p.file)) byFile.set(p.file, [])
  byFile.get(p.file)!.push(p)
}

for (const [file, filePlans] of byFile) {
  let src = readFileSync(file, 'utf8')
  // 重新定位每一处（改一处后下标会变），所以每次都从当前 src 重新算
  for (const plan of filePlans) {
    const m = src.match(new RegExp(`export async function ${plan.verb}\\s*\\(`))
    if (!m || m.index === undefined) continue
    const after = src.slice(m.index + m[0].length)
    const nextIdx = after.search(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/)
    const body = nextIdx === -1 ? after : after.slice(0, nextIdx)
    const wIdx = body.search(/\bwithAuth(?:Cached)?\(|\bwithCachedAuth\(/)
    if (wIdx === -1) continue
    const abs = m.index + m[0].length + wIdx
    const open = src.indexOf('(', abs)
    const close = matchParen(src, open)
    const range = thirdArgRange(src, open, close)
    if (!range) continue
    const original = src.slice(range[0], range[1])
    // 保留原有的前后空白布局，只换内容
    const leading = original.match(/^\s*/)?.[0] ?? ' '
    const trailing = original.match(/\s*$/)?.[0] ?? ''
    src = src.slice(0, range[0]) + leading + plan.to + trailing + src.slice(range[1])
  }
  writeFileSync(file, src, 'utf8')
}

// ── ⛔ 回扫验证：编译通过什么都证明不了 ───────────────────────────────────
const after = new Map<string, ReturnType<typeof scanApiHandlers>[number]['gate']>(
  scanApiHandlers().map((h) => [`${h.verb} ${h.route}`, h.gate]),
)
const failures: string[] = []
for (const p of plans) {
  const gate = after.get(`${p.verb} ${p.route}`)
  if (!gate || gate.kind !== 'permission') {
    failures.push(`${p.verb} ${p.route}：改写后 gate 是 ${gate?.kind ?? '缺失'}，不是 permission`)
    continue
  }
  const got = [...gate.permissions].sort().join(',')
  const want = [...p.permissions].sort().join(',')
  if (got !== want) failures.push(`${p.verb} ${p.route}：期望 ${want}，实际 ${got}`)
}

if (failures.length > 0) {
  console.log(`\n⛔ 回扫验证失败 ${failures.length} 处：`)
  failures.forEach((f) => console.log('   ' + f))
  process.exit(1)
}
console.log(`\n✅ 已改写 ${plans.length} 处，回扫验证全部通过（gate 确实是权限点，不是插进注释里的死代码）`)
