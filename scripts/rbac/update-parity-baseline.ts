/**
 * 把**新增的 handler** 纳入平迁基线。
 * ============================================================================
 * ⛔ 这个脚本只做加法，不改已有的格。
 *
 * 基线（lib/rbac/parity-baseline.json）代表「改造前的可达性」，是证明
 * 「换了引擎但一格权限都没动」的唯一依据。允许它被随便重写的话，
 * 那条零 diff 测试就退化成拿改动后的自己和改动后的自己比，什么都守不住。
 *
 * 所以：
 *   - 基线里**已经存在**的 handler：一个格都不动，改了就说明真的动了权限，
 *     那必须在提交信息里解释，而不是刷新基线糊过去
 *   - 基线里**没有**的 handler：这是本次新增的接口，把它当前的可达性写进去，
 *     并打印出来让 review 看见谁能够到它
 *
 * 用法：npx tsx scripts/rbac/update-parity-baseline.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { scanApiHandlers } from '../../lib/route-gate-scan'
import { isPublicApiRoute } from '../../lib/public-routes'
import { PROBE_ROLES, type Reach } from '../../lib/role-reachability'
import { API_ROUTE_RULES, requiredPermissionsFor } from '../../lib/rbac/route-map'

const PATH = 'lib/rbac/parity-baseline.json'
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

const baseline = JSON.parse(readFileSync(PATH, 'utf-8')) as Record<string, Record<string, Reach>>
const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as {
  roles: Array<{ legacyRole: string; permissions: string[] }>
}
const permsByRole = new Map(seed.roles.map((r) => [r.legacyRole, new Set(r.permissions)]))

const added: Array<{ key: string; reachable: string[] }> = []

for (const h of scanApiHandlers()) {
  const key = `${h.verb} ${h.route}`
  if (baseline[key]) continue // ⛔ 已有的一个格都不动

  const path = fillParams(h.route)
  const required = requiredPermissionsFor(API_ROUTE_RULES, path, h.verb)
  const row: Record<string, Reach> = {}
  for (const role of PROBE_ROLES) {
    if (isPublicApiRoute(path)) { row[role] = 'anon'; continue }
    if (required === undefined) { row[role] = 'n'; continue }
    if (required === null) { row[role] = 'y'; continue }
    row[role] = required.some((p) => (permsByRole.get(role) ?? new Set()).has(p)) ? 'y' : 'n'
  }
  baseline[key] = row
  added.push({ key, reachable: PROBE_ROLES.filter((r) => row[r] === 'y') })
}

const removed = Object.keys(baseline).filter(
  (k) => !scanApiHandlers().some((h) => `${h.verb} ${h.route}` === k),
)

if (added.length === 0 && removed.length === 0) {
  console.log('基线无需变更。')
  process.exit(0)
}

writeFileSync(PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8')

if (added.length > 0) {
  console.log(`纳入 ${added.length} 个新增 handler —— 逐条确认谁能够到它：\n`)
  for (const a of added) {
    console.log(`  ${a.key}`)
    console.log(`     可达：${a.reachable.length > 0 ? a.reachable.join(', ') : '（无人）'}`)
  }
}
if (removed.length > 0) {
  console.log(`\n⚠️ 基线里有 ${removed.length} 个 handler 已从代码中消失，未自动删除（先确认是有意删的）：`)
  removed.forEach((k) => console.log('   ' + k))
}
