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
 *   Needed(r)    = ∪ { P(u) : 角色 r 现在够得着 u }     ← 有证据表明它需要的
 *   Forbidden(r) = ∪ { P(u) : 角色 r 现在够不着 u }     ← 有证据表明它不该有的
 *   Allowed(r)   = Needed(r) − Forbidden(r)
 *
 * ⛔ 最初写的是 `Allowed(r) = 全部权限点 − Forbidden(r)`，**那是错的**：
 * 没有任何 handler 引用的权限点不会进任何人的 Forbidden，于是**所有角色都会拿到它**。
 * 实测后果 —— `system.rbac.read/manage` 在推导时还没有对应接口（配置页尚未开发），
 * 结果 12 个角色全都拿到了「管理任何人的权限」。司机能改老板的权限，而且不报错。
 * 改成从 Needed 出发之后，没有证据支持的权限点一个都不发。
 *
 * 为什么这样就对：
 *   - 不会多出可达性：r 够不着的 u，其所需权限点已全部进 Forbidden。
 *   - 不会凭空多出权限：只有 r 够得着的 u 引用过的权限点才可能进 Needed。
 *   - 会不会少了可达性：逐条检查 —— 对每个 r 够得着的 u，
 *     P(u) ∩ Allowed(r) 必须非空。**检查失败的地方就是 route-map 粒度不够的地方**。
 *
 * 输出：
 *   - prisma/seed-rbac.json     12 个预置角色的权限点清单（T2 与 seed 用）
 *   - docs/20260807-rbac-derivation-report.md   推导报告 + 冲突 + MATRIX 交叉校验
 */
import { writeFileSync, readFileSync } from 'node:fs'
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

const needed = new Map<string, Set<string>>(PROBE_ROLES.map((r) => [r, new Set<string>()]))
const forbidden = new Map<string, Set<string>>(PROBE_ROLES.map((r) => [r, new Set<string>()]))
/** 记录每个权限点是被哪个 handler 拉进 Forbidden 的，用于解释冲突 */
const forbiddenReason = new Map<string, Map<string, string>>(
  PROBE_ROLES.map((r) => [r, new Map<string, string>()]),
)

/**
 * ⛔ 「改造前的可达性」必须读**冻结基线**，不能实时算。
 *
 * 原来的写法是 `canRolesAccessApi(...) AND handler 的 allowedRoles`。但 T5 已经把
 * 全部 allowedRoles 拆成了权限点闸，`scanApiHandlers` 再也读不到角色列表 ——
 * 实时算出来的「改造前」于是只剩 middleware 一层，比真实的改造前宽松得多，
 * 推出来的角色权限也就跟着放宽。
 *
 * 这与 T5 修过的另外三处度量工具失真是同一个病，当时漏了这个文件
 * （T1 之后就没再跑过它，直到 T10 新增路由才重新触发）。
 */
const BASELINE = JSON.parse(
  readFileSync('lib/rbac/parity-baseline.json', 'utf-8'),
) as Record<string, Record<string, 'anon' | 'y' | 'n'>>

const reachableUnits: Array<{ label: string; path: string; verb: string }> = []

for (const h of handlers) {
  const path = fillParams(h.route)
  if (isPublicApiRoute(path)) continue
  reachableUnits.push({ label: `${h.verb} ${h.route}`, path, verb: h.verb })
}

/**
 * 改造前 role 能否够到这个 handler。
 * 基线里没有的 handler = 改造后新增的（如权限配置页自己的接口）→ 一律视为够不着，
 * 这样它们的权限点不会被发给任何预置角色，只能由管理员显式勾选。
 */
function reachableNow(role: string, u: (typeof reachableUnits)[number]): boolean {
  return BASELINE[u.label]?.[role] === 'y'
}

for (const role of PROBE_ROLES) {
  for (const u of reachableUnits) {
    const req = requiredPermissionsFor(API_ROUTE_RULES, u.path, u.verb)
    if (!req) continue // 无需权限的接口不产生约束
    if (reachableNow(role, u)) {
      for (const id of req) needed.get(role)!.add(id)
      continue
    }
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
    const req = requiredPermissionsFor(PAGE_ROUTE_RULES, page, 'GET')
    if (!req) continue
    if (canRolesAccessPage([role], page)) {
      for (const id of req) needed.get(role)!.add(id)
      continue
    }
    for (const id of req) {
      forbidden.get(role)!.add(id)
      if (!forbiddenReason.get(role)!.has(id)) forbiddenReason.get(role)!.set(id, `页面 ${page}`)
    }
  }
}

const allowed = new Map<string, string[]>()
for (const role of PROBE_ROLES) {
  const f = forbidden.get(role)!
  const n = needed.get(role)!
  // ⛔ 从 Needed 出发，不是从全集出发 —— 见文件头说明
  allowed.set(role, ALL_PERMISSIONS.filter((id) => n.has(id) && !f.has(id)))
}

// 没有任何角色拿到的权限点：多半是「改造前不存在这个功能」，如权限配置页自己的接口。
// 显式列出来，避免它们被悄悄遗忘。
const orphans = ALL_PERMISSIONS.filter(
  (id) => !PROBE_ROLES.some((r) => allowed.get(r)!.includes(id)),
)

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

// ── 步骤 3.5：有意新增的权限（不属于平迁范围）────────────────────────────
/**
 * 权限点是从**改造前的可达性**反推的，所以「改造前不存在的功能」不会落到任何
 * 预置角色头上。权限配置页就是这种情况 —— 它的接口是 20260807 新增的，
 * 反推的结果是 `system.rbac.*` 无人拥有，表现为**配置页做好了却没人进得去**。
 *
 * 这类权限必须在这里显式登记，理由写清楚。登记在这里而不是手改 seed，
 * 是为了让 `derive-system-roles.ts` 重跑之后不会把它们丢掉。
 */
const INTENTIONAL_GRANTS: Array<{ role: string; permissions: string[]; why: string }> = [
  {
    role: 'BOSS',
    permissions: ['system.rbac.read', 'system.rbac.manage'],
    why: '权限配置页是本次新增的功能，改造前不存在，反推不出来。老板要能配权限。',
  },
  {
    role: 'OPERATOR',
    permissions: ['system.rbac.read', 'system.rbac.manage'],
    why: '运营是后台本身，日常的账号与角色维护由他们做。',
  },
]

for (const g of INTENTIONAL_GRANTS) {
  const list = allowed.get(g.role)
  if (!list) continue
  for (const id of g.permissions) if (!list.includes(id)) list.push(id)
  list.sort((a, b) => ALL_PERMISSIONS.indexOf(a) - ALL_PERMISSIONS.indexOf(b))
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
lines.push('## 1.2 有意新增的权限（不属于平迁范围）')
lines.push('')
lines.push('| 角色 | 权限点 | 理由 |')
lines.push('|---|---|---|')
for (const g of INTENTIONAL_GRANTS) {
  lines.push(`| ${g.role} | ${g.permissions.join('、')} | ${g.why} |`)
}
lines.push('')
lines.push('## 1.5 无人拥有的权限点')
lines.push('')
if (orphans.length === 0) {
  lines.push('无。')
} else {
  lines.push(`${orphans.length} 个权限点没有任何预置角色拥有 —— 这通常是对的：`)
  lines.push('它们对应「改造前不存在的功能」（例如权限配置页自己的接口）。')
  lines.push('要让某个岗位用上，得在配置页里显式勾给它。')
  lines.push('')
  lines.push('```')
  orphans.forEach((id) => lines.push(id))
  lines.push('```')
}
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

console.log(`权限点 ${ALL_PERMISSIONS.length} · handler ${handlers.length} · 冲突 ${conflicts.length} · 无人拥有 ${orphans.length}`)
for (const r of roles) console.log(`  ${r.legacyRole.padEnd(15)} ${String(r.permissions.length).padStart(3)}  ${r.dataScope}`)
if (conflicts.length > 0) {
  console.log('\n冲突明细：')
  for (const c of conflicts.slice(0, 40)) {
    console.log(`  ${c.role.padEnd(15)} ${c.what.padEnd(45)} 需要 ${c.needs.join(' 或 ')}`)
  }
  if (conflicts.length > 40) console.log(`  … 还有 ${conflicts.length - 40} 条，见报告`)
  process.exit(2)
}
