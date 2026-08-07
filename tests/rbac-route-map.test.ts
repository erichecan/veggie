import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scanApiHandlers } from '../lib/route-gate-scan'
import { buildReachabilityMatrix, PROBE_ROLES, type Reach } from '../lib/role-reachability'
import { isPublicApiRoute } from '../lib/public-routes'
import { isKnownPermission } from '../lib/rbac/catalog'
import {
  API_ROUTE_RULES,
  PAGE_ROUTE_RULES,
  requiredPermissionsFor,
} from '../lib/rbac/route-map'

const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

interface SeedRole {
  legacyRole: string
  permissions: string[]
}
const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as { roles: SeedRole[] }
const permsByRole = new Map(seed.roles.map((r) => [r.legacyRole, new Set(r.permissions)]))

test('route-map 只引用 catalog 里存在的权限点', () => {
  const bad: string[] = []
  for (const rule of [...API_ROUTE_RULES, ...PAGE_ROUTE_RULES]) {
    if (rule.permission === null) continue
    const ids = typeof rule.permission === 'string' ? [rule.permission] : rule.permission
    for (const id of ids) if (!isKnownPermission(id)) bad.push(`${rule.pattern} → ${id}`)
  }
  assert.deepEqual(bad, [], 'route-map 引用了不存在的权限点')
})

/**
 * 未命中任何规则 = 拒绝。所以漏登记一个新接口的表现是 403（功能坏掉），
 * 而不是敞开（安全漏洞）。这条测试保证新接口不会因为忘了登记而静默坏掉。
 */
test('每个 API handler 都能命中一条规则', () => {
  const uncovered = scanApiHandlers()
    .filter((h) => requiredPermissionsFor(API_ROUTE_RULES, fillParams(h.route), h.verb) === undefined)
    .map((h) => `${h.verb} ${h.route}`)
  assert.deepEqual(uncovered, [], '这些接口没有任何 route-map 规则命中，会全员 403')
})

/**
 * ⛔ 平迁安全绳。改 route-map、改 catalog、改 seed 都可能悄悄改变某个角色的可达性，
 * 而这种改变不会有任何报错 —— 只会在生产上表现为「某个岗位突然打不开页面」
 * 或者更糟：「某个岗位突然能看到不该看的数据」。
 *
 * 这条测试逐格比对新旧两套体系算出的可达性矩阵，任何一格不同都会失败。
 * 真要改权限，正确做法是改完 seed 后**显式**更新基线，让 review 看得见。
 */
test('新旧体系的可达性矩阵逐格相同（平迁零 diff）', () => {
  const oldMatrix = buildReachabilityMatrix()
  const diffs: string[] = []

  for (const h of scanApiHandlers()) {
    const key = `${h.verb} ${h.route}`
    const path = fillParams(h.route)
    const required = requiredPermissionsFor(API_ROUTE_RULES, path, h.verb)
    for (const role of PROBE_ROLES) {
      let now: Reach
      if (isPublicApiRoute(path)) now = 'anon'
      else if (required === undefined) now = 'n'
      else if (required === null) now = 'y'
      else now = required.some((p) => (permsByRole.get(role) ?? new Set()).has(p)) ? 'y' : 'n'

      const before = oldMatrix[key]?.[role]
      if (before !== now) diffs.push(`${key} [${role}]: 旧 ${before} → 新 ${now}`)
    }
  }

  assert.deepEqual(diffs.slice(0, 20), [], `可达性发生了 ${diffs.length} 处变化`)
})

test('12 个预置角色都推出来了', () => {
  assert.equal(seed.roles.length, PROBE_ROLES.length)
  const missing = PROBE_ROLES.filter((r) => !permsByRole.has(r))
  assert.deepEqual(missing, [], '这些角色没有推导结果')
})

test('OTHER 与 PICKER 只有最小权限', () => {
  // 这两个角色现网就是「进不去任何业务页面」的状态，8/6 审计已确认。
  // 如果哪天它们的权限数暴涨，多半是 route-map 写漏了兜底规则。
  for (const role of ['OTHER', 'PICKER']) {
    const n = permsByRole.get(role)!.size
    assert.ok(n < 30, `${role} 有 ${n} 个权限点，远超预期的最小集`)
  }
})

test('外部角色的数据范围是 OWN', () => {
  const byRole = new Map(seed.roles.map((r) => [r.legacyRole, r]))
  for (const role of ['RESTAURANT', 'EXTERNAL_SALES']) {
    assert.equal(
      (byRole.get(role) as unknown as { dataScope: string }).dataScope,
      'OWN',
      `${role} 必须只看自己的数据`,
    )
  }
})
