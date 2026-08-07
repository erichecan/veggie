import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { legacyRolesHavePermission } from '../lib/rbac/legacy-roles'
import { scanApiHandlers } from '../lib/route-gate-scan'
import { canAccessApi } from '../lib/rbac/gate'
import { isPublicApiRoute } from '../lib/public-routes'
import { PROBE_ROLES, type Reach } from '../lib/role-reachability'

const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')
const baseline = JSON.parse(readFileSync('lib/rbac/parity-baseline.json', 'utf-8')) as
  Record<string, Record<string, Reach>>

/**
 * ⛔ 这条测试是为了守住一个**在生产上实际发生过**的问题。
 *
 * T5 把 154 个 handler 的闸门改成 `{ require: '权限点' }`，而权限点只存在于新
 * token 的位图里。部署后所有还没重新登录的人手里都是没有 `pm` 的旧 token，
 * 于是这些接口对他们全部 403 —— 生产实测 RESTAURANT 被挡在了自己的门户外面。
 *
 * 当时 middleware 层做了回退，但**路由层的 withAuth 没有**，而所有测试都只测了
 * 其中一层，所以全绿。这里补上：把两层合起来，逐个 handler 比对旧 token 的
 * 最终可达性与改造前基线。
 */
test('旧 token 的最终可达性与改造前基线逐格相同', () => {
  const diffs: string[] = []

  for (const h of scanApiHandlers()) {
    const key = `${h.verb} ${h.route}`
    const path = fillParams(h.route)
    if (isPublicApiRoute(path)) continue

    for (const role of PROBE_ROLES) {
      // 第一层：middleware（旧 token 走角色白名单回退）
      const passMiddleware = canAccessApi({ role, roles: [role] }, path, h.verb)

      // 第二层：路由自身的闸。旧 token 没有位图，权限点闸走角色反查
      const passGate =
        h.gate.kind === 'permission' ? legacyRolesHavePermission([role], h.gate.permissions)
        : h.gate.kind === 'roles' ? h.gate.roles.includes(role)
        : true

      const now: Reach = passMiddleware && passGate ? 'y' : 'n'
      const before = baseline[key]?.[role]
      if (before !== now) diffs.push(`${key} [${role}]: 改造前 ${before} → 旧 token 现在 ${now}`)
    }
  }

  assert.deepEqual(
    diffs.slice(0, 20),
    [],
    `旧 token 的可达性变了 ${diffs.length} 格 —— 部署后没重新登录的人会看到功能坏掉或越权`,
  )
})

test('权限点反查表认得真权限点', () => {
  assert.ok(legacyRolesHavePermission(['RESTAURANT'], ['portal.self.access']))
  assert.ok(!legacyRolesHavePermission(['RESTAURANT'], ['master.customer.read']))
  assert.ok(legacyRolesHavePermission(['BOSS'], ['system.backup.manage']))
  assert.ok(!legacyRolesHavePermission(['DRIVER'], ['system.backup.manage']))
})

test('反查表查不到的权限点一律拒绝', () => {
  // 宁可让旧 token 用户重新登录，也不放行一个来历不明的权限
  assert.ok(!legacyRolesHavePermission(['BOSS'], ['brand.new.permission']))
  assert.ok(!legacyRolesHavePermission([], ['portal.self.access']))
})
