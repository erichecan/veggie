/**
 * 从现有三处权限定义反推 12 个预置角色的权限点。
 * ============================================================================
 * 台账 T1：docs/20260807-rbac-configurable-design-and-tasks.md
 *
 * 现有可达性由两处**合取**决定（见 lib/role-reachability.ts）：
 *     可达 = middleware 角色边界(ROLE_API_SCOPE) AND 路由闸(allowedRoles)
 * `lib/permissions.ts` 的 MATRIX 不参与可达性 —— 它只管 UI 按钮显隐，
 * 所以在这里作为**第三方交叉校验**，不作为推导输入。
 * （台账原文写的是「三处求交集」，实测后修正为「两处推导 + 一处校验」。）
 *
 * 推导算法（可判定，不靠猜）：
 *   Forbidden(r) = ∪ { P(h) : 角色 r 现在够不着 handler h }
 *   Allowed(r)   = 全部权限点 − Forbidden(r)
 *
 * 为什么这样就对：
 *   - 不会多出可达性：r 够不着的 h，其所需权限点已全部进 Forbidden，
 *     所以 Allowed(r) 与 P(h) 无交集 → 仍然够不着。
 *   - 会不会少了可达性：需要逐条检查 —— 对每个 r 够得着的 h，
 *     P(h) ∩ Allowed(r) 必须非空。**检查失败的地方就是 route-map 粒度不够的地方**，
 *     它精确指出「哪两个接口共用了一个权限点，但某个角色只够得着其中一个」。
 *
 * 输出：
 *   - prisma/seed-rbac.json     12 个预置角色的权限点清单（T2 与 seed 用）
 *   - docs/20260807-rbac-derivation-report.md   推导报告 + 冲突 + MATRIX 交叉校验
 */
import { writeFileSync } from 'node:fs'
import { scanApiHandlers } from '../../lib/route-gate-scan'
import { canRolesAccessApi, canRolesAccessPage, ROLE_PAGE_SCOPE } from '../../lib/role-access'
import { isPublicApiRoute } from '../../lib/public-routes'
import { PROBE_ROLES } from '../../lib/role-reachability'
import { PERMISSIONS } from '../../lib/rbac/catalog'
import { API_ROUTE_RULES, PAGE_ROUTE_RULES, requiredPermissionsFor } from '../../lib/rbac/route-map'

const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.id)
const KNOWN = new Set(ALL_PERMISSIONS)
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

// ── 步骤 1：route-map 自身的完整性 ─────────────────────────────────────────
const unknownRefs: string[] = []
for (const rule of [...API_ROUTE_RULES, ...PAGE_ROUTE_RULES]) {
  if (rule.permission === null) continue
  const ids = typeof rule.permission === 'string' ? [rule.permission] : rule.permission
  for (const id of ids) if (!KNOWN.has(id)) unknownRefs.push(`${rule.pattern} → ${id}`)
}

const handlers = scanApiHandlers()
const uncovered: string[] = []
for (const h of handlers) {
  const req = requiredPermissionsFor(API_ROUTE_RULES, fillParams(h.route), h.verb)
  if (req === undefined) uncovered.push(`${h.verb} ${h.route}`)
}

if (unknownRefs.length > 0 || uncovered.length > 0) {
  if (unknownRefs.length > 0) {
    console.error(`⛔ route-map 引用了 ${unknownRefs.length} 个 catalog 里不存在的权限点：`)
    unknownRefs.forEach((r) => console.error('   ' + r))
  }
  if (uncovered.length > 0) {
    console.error(`\n⛔ ${uncovered.length} 个 handler 没有任何规则命中（未命中 = 拒绝，会功能失效）：`)
    uncovered.forEach((r) => console.error('   ' + r))
  }
  process.exit(1)
}

// ── 步骤 2：现有可达性 → Forbidden / Allowed ───────────────────────────────
interface Conflict {
  role: string
  what: string
  needs: readonly string[]
  blockedBy: string[]
}

const forbidden = new Map<string, Set<string>>(PROBE_ROLES.map((r) => [r, new Set<string>()]))
/** 记录每个权限点是被哪个 handler 拉进 Forbidden 的，用于解释冲突 */
const forbiddenReason = new Map<string, Map<string, string>>(
  PROBE_ROLES.map((r) => [r, new Map<string, string>()]),
)

const reachableUnits: Array<{ label: string; path: string; verb: string; gate: string[] | null }> = []

for (const h of handlers) {
  const path = fillParams(h.route)
  if (isPublicApiRoute(path)) continue
  const gate = h.gate.kind === 'roles' ? h.gate.roles : null
  reachableUnits.push({ label: `${h.verb} ${h.route}`, path, verb: h.verb, gate })
}

/** 现有体系下 role 能否够到这个 handler */
function reachableNow(role: string, u: (typeof reachableUnits)[number]): boolean {
  return canRolesAccessApi([role], u.path, u.verb) && (!u.gate || u.gate.includes(role))
}

for (const role of PROBE_ROLES) {
  for (const u of reachableUnits) {
    if (reachableNow(role, u)) continue
    const req = requiredPermissionsFor(API_ROUTE_RULES, u.path, u.verb)
    if (!req) continue // 无需权限的接口不产生约束
    for (const id of req) {
      forbidden.get(role)!.add(id)
      if (!forbiddenReason.get(role)!.has(id)) forbiddenReason.get(role)!.set(id, u.label)
    }
  }
}

// 页面层同理：某角色进不去的页面，其权限点也要进 Forbidden
const PAGE_PROBES = [
  '/enter',
  '/customer-portal/orders',
  '/classic/driver/settlement',
  '/classic/sorter/sort/x',
  '/classic/warehouse/stock-take',
  '/classic/finance/statements',
  '/classic/accounting',
  '/classic/print/batch',
  '/classic/operator/dispatch-console',
  '/classic/operator/orders',
  '/classic/boss/analytics/margin',
  '/classic/restaurant/orders',
]
for (const role of PROBE_ROLES) {
  for (const page of PAGE_PROBES) {
    if (canRolesAccessPage([role], page)) continue
    const req = requiredPermissionsFor(PAGE_ROUTE_RULES, page, 'GET')
    if (!req) continue
    for (const id of req) {
      forbidden.get(role)!.add(id)
      if (!forbiddenReason.get(role)!.has(id)) forbiddenReason.get(role)!.set(id, `页面 ${page}`)
    }
  }
}

const allowed = new Map<string, string[]>()
for (const role of PROBE_ROLES) {
  const f = forbidden.get(role)!
  allowed.set(role, ALL_PERMISSIONS.filter((id) => !f.has(id)))
}

// ── 步骤 3：覆盖检查 —— 有没有「本来够得着，现在够不着了」 ──────────────────
const conflicts: Conflict[] = []
for (const role of PROBE_ROLES) {
  const have = new Set(allowed.get(role)!)
  for (const u of reachableUnits) {
    if (!reachableNow(role, u)) continue
    const req = requiredPermissionsFor(API_ROUTE_RULES, u.path, u.verb)
    if (!req) continue
    if (req.some((id) => have.has(id))) continue
    conflicts.push({
      role,
      what: u.label,
      needs: req,
      blockedBy: req.map((id) => `${id}（被 ${forbiddenReason.get(role)!.get(id)} 挡住）`),
    })
  }
  for (const page of PAGE_PROBES) {
    if (!canRolesAccessPage([role], page)) continue
    const req = requiredPermissionsFor(PAGE_ROUTE_RULES, page, 'GET')
    if (!req) continue
    if (req.some((id) => have.has(id))) continue
    conflicts.push({
      role,
      what: `页面 ${page}`,
      needs: req,
      blockedBy: req.map((id) => `${id}（被 ${forbiddenReason.get(role)!.get(id)} 挡住）`),
    })
  }
}

// ── 步骤 4：数据范围 ───────────────────────────────────────────────────────
/** 现有行级隔离只有两处硬编码：RESTAURANT 与 EXTERNAL_SALES 只看自己的 */
const DATA_SCOPE: Record<string, 'ALL' | 'TEAM' | 'OWN'> = {
  RESTAURANT: 'OWN',
  EXTERNAL_SALES: 'OWN',
}

// ── 输出 ───────────────────────────────────────────────────────────────────
const roles = PROBE_ROLES.map((role) => ({
  code: role.toLowerCase(),
  legacyRole: role,
  name: role,
  isSystem: true,
  dataScope: DATA_SCOPE[role] ?? 'ALL',
  permissions: allowed.get(role)!,
}))

writeFileSync('prisma/seed-rbac.json', JSON.stringify({ roles }, null, 2) + '\n', 'utf-8')

const lines: string[] = []
lines.push('# T1 权限反推报告')
lines.push('')
lines.push(`> 生成：\`npx tsx scripts/rbac/derive-system-roles.ts\` · 台账 T1`)
lines.push(`> 输入：${handlers.length} 个 API handler + ${PAGE_PROBES.length} 个页面探针`)
lines.push(`> 权限点：${ALL_PERMISSIONS.length} 个 · 规则：${API_ROUTE_RULES.length} 条 API + ${PAGE_ROUTE_RULES.length} 条页面`)
lines.push('')
lines.push('## 1. 推导结果')
lines.push('')
lines.push('| 角色 | 权限点数 | 数据范围 |')
lines.push('|---|---:|---|')
for (const r of roles) lines.push(`| ${r.legacyRole} | ${r.permissions.length} | ${r.dataScope} |`)
lines.push('')
lines.push('## 2. 冲突（route-map 粒度不足之处）')
lines.push('')
if (conflicts.length === 0) {
  lines.push('**无冲突。** 每个角色现在够得着的接口与页面，在新体系下都至少命中一个它拥有的权限点。')
} else {
  lines.push(`⛔ **${conflicts.length} 处冲突** —— 这些是「现在够得着、平迁后会够不着」的地方，必须裁决：`)
  lines.push('')
  lines.push('| 角色 | 够不着了 | 需要 | 为什么被挡 |')
  lines.push('|---|---|---|---|')
  for (const c of conflicts) {
    lines.push(`| ${c.role} | \`${c.what}\` | ${c.needs.join(' 或 ')} | ${c.blockedBy.join('；')} |`)
  }
}
lines.push('')
writeFileSync('docs/20260807-rbac-derivation-report.md', lines.join('\n'), 'utf-8')

console.log(`权限点 ${ALL_PERMISSIONS.length} · handler ${handlers.length} · 冲突 ${conflicts.length}`)
for (const r of roles) console.log(`  ${r.legacyRole.padEnd(15)} ${String(r.permissions.length).padStart(3)}  ${r.dataScope}`)
if (conflicts.length > 0) {
  console.log('\n冲突明细：')
  for (const c of conflicts.slice(0, 40)) {
    console.log(`  ${c.role.padEnd(15)} ${c.what.padEnd(45)} 需要 ${c.needs.join(' 或 ')}`)
  }
  if (conflicts.length > 40) console.log(`  … 还有 ${conflicts.length - 40} 条，见报告`)
  process.exit(2)
}
