/**
 * 平迁验证：新旧两套权限体系算出的可达性矩阵必须逐格相同。
 * ============================================================================
 * 台账 T2 / T7：docs/20260807-rbac-configurable-design-and-tasks.md
 *
 * 这是整个改造的安全绳。它证明的是一件很窄但很关键的事：
 * **换了引擎，但一格权限都没动。** 之后再改权限，才是有意为之的变更。
 *
 * 旧体系：middleware 角色边界(ROLE_API_SCOPE) AND 路由闸(allowedRoles)
 * 新体系：route-map 要求的权限点 ∩ 角色权限集 ≠ ∅
 *
 * 顺带校验 scripts/audit/role-reachability.json 快照是不是还新鲜 —— 快照过期的话
 * 「与快照一致」就成了自欺欺人。
 */
import { readFileSync } from 'node:fs'
import { buildReachabilityMatrix, PROBE_ROLES, type Reach } from '../../lib/role-reachability'
import { scanApiHandlers } from '../../lib/route-gate-scan'
import { isPublicApiRoute } from '../../lib/public-routes'
import { API_ROUTE_RULES, requiredPermissionsFor } from '../../lib/rbac/route-map'

interface SeedRole {
  legacyRole: string
  permissions: string[]
}

const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as { roles: SeedRole[] }
const permsByRole = new Map(seed.roles.map((r) => [r.legacyRole, new Set(r.permissions)]))
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

/** 新体系下的可达性 */
function buildNewMatrix(): Record<string, Record<string, Reach>> {
  const matrix: Record<string, Record<string, Reach>> = {}
  for (const h of scanApiHandlers()) {
    const path = fillParams(h.route)
    const row: Record<string, Reach> = {}
    const required = requiredPermissionsFor(API_ROUTE_RULES, path, h.verb)
    for (const role of PROBE_ROLES) {
      if (isPublicApiRoute(path)) { row[role] = 'anon'; continue }
      if (required === undefined) { row[role] = 'n'; continue } // 未登记 = 拒绝
      if (required === null) { row[role] = 'y'; continue }      // 登录即可
      const have = permsByRole.get(role) ?? new Set<string>()
      row[role] = required.some((p) => have.has(p)) ? 'y' : 'n'
    }
    matrix[`${h.verb} ${h.route}`] = row
  }
  return matrix
}

const oldMatrix = buildReachabilityMatrix()
const newMatrix = buildNewMatrix()

const diffs: string[] = []
const keys = new Set([...Object.keys(oldMatrix), ...Object.keys(newMatrix)])
for (const key of [...keys].sort()) {
  const o = oldMatrix[key]
  const n = newMatrix[key]
  if (!o) { diffs.push(`${key}: 只在新体系里存在`); continue }
  if (!n) { diffs.push(`${key}: 只在旧体系里存在`); continue }
  for (const role of PROBE_ROLES) {
    if (o[role] !== n[role]) diffs.push(`${key} [${role}]: 旧 ${o[role]} → 新 ${n[role]}`)
  }
}

const cells = keys.size * PROBE_ROLES.length
console.log(`逐格比对 ${keys.size} 个 handler × ${PROBE_ROLES.length} 个角色 = ${cells} 格`)

// 顺带：快照是否还新鲜
let snapshotNote = ''
try {
  const snap = JSON.parse(readFileSync('scripts/audit/role-reachability.json', 'utf-8')) as
    Record<string, Record<string, Reach>>
  let stale = 0
  for (const [k, row] of Object.entries(oldMatrix)) {
    const s = snap[k]
    if (!s) { stale++; continue }
    for (const role of PROBE_ROLES) if (s[role] !== row[role]) { stale++; break }
  }
  snapshotNote = stale === 0
    ? 'CI 快照与旧体系实时计算一致（快照是新鲜的）'
    : `⚠️ CI 快照与旧体系实时计算有 ${stale} 处不同 —— 快照已过期，「与快照一致」不足以证明平迁`
} catch {
  snapshotNote = '⚠️ 读不到 scripts/audit/role-reachability.json'
}
console.log(snapshotNote)

if (diffs.length === 0) {
  console.log('\n✅ 零 diff —— 换了引擎，一格权限都没动。')
  process.exit(0)
}
console.log(`\n⛔ ${diffs.length} 处不一致：`)
diffs.slice(0, 60).forEach((d) => console.log('   ' + d))
if (diffs.length > 60) console.log(`   … 还有 ${diffs.length - 60} 处`)
process.exit(1)
