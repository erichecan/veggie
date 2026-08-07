import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canAccessApi, canAccessPage, hasBitmap, rolesOf } from '../lib/rbac/gate'
import { canRolesAccessApi, canRolesAccessPage } from '../lib/role-access'
import { encodePermissions } from '../lib/rbac/bitmap'
import { scanApiHandlers } from '../lib/route-gate-scan'

import { isPublicApiRoute } from '../lib/public-routes'

interface SeedRole {
  legacyRole: string
  permissions: string[]
}
const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as { roles: SeedRole[] }
const bitmapOf = new Map(seed.roles.map((r) => [r.legacyRole, encodePermissions(r.permissions)]))
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

const oldToken = (role: string) => ({ role, roles: [role] })
const newToken = (role: string) => ({ role, roles: [role], pm: bitmapOf.get(role) })

test('hasBitmap 区分新旧 token', () => {
  assert.ok(!hasBitmap(oldToken('SALES')))
  assert.ok(!hasBitmap({ role: 'SALES', pm: '' }))
  assert.ok(hasBitmap(newToken('SALES')))
})

test('rolesOf：roles[] 优先，空则回退单 role', () => {
  assert.deepEqual(rolesOf({ role: 'OPERATOR', roles: ['OPERATOR', 'SALES'] }), ['OPERATOR', 'SALES'])
  assert.deepEqual(rolesOf({ role: 'OPERATOR', roles: [] }), ['OPERATOR'])
  assert.deepEqual(rolesOf({ role: 'OPERATOR' }), ['OPERATOR'])
  assert.deepEqual(rolesOf({}), [])
})

/**
 * ⛔ 部署那一刻所有在线用户手里都是旧 token（有效期 7 天）。这条路径要是断了，
 * 全员被挡在门外，包括没法登录进去改配置的管理员。
 */
test('旧 token（无位图）走回退路径，行为与改造前完全一致', () => {
  const probes: Array<[string, string]> = [
    ['/api/orders', 'GET'],
    ['/api/orders/x', 'PUT'],
    ['/api/customers', 'GET'],
    ['/api/trips/x/settlement', 'POST'],
    ['/api/backups', 'GET'],
    ['/api/pricelists', 'POST'],
  ]
  const roles = ['BOSS', 'OPERATOR', 'FINANCE', 'DRIVER', 'SALES', 'RESTAURANT', 'SORTER']
  for (const role of roles) {
    for (const [path, method] of probes) {
      assert.equal(
        canAccessApi(oldToken(role), path, method),
        canRolesAccessApi([role], path, method),
        `旧 token 回退路径与原逻辑不一致：${role} ${method} ${path}`,
      )
    }
  }
})

test('旧 token 的页面判定同样走回退路径', () => {
  const pages = ['/classic/operator/orders', '/classic/driver', '/classic/finance', '/customer-portal/orders']
  for (const role of ['BOSS', 'DRIVER', 'FINANCE', 'RESTAURANT', 'SALES']) {
    for (const page of pages) {
      assert.equal(
        canAccessPage(oldToken(role), page),
        canRolesAccessPage([role], page),
        `旧 token 页面回退不一致：${role} ${page}`,
      )
    }
  }
})

/**
 * 新体系的 middleware 层比旧体系更严：旧的 middleware 只按前缀粗判，细处
 * （同一前缀下 GET 可以、DELETE 不行）要靠路由自己的 allowedRoles 补；
 * 新的 route-map 一层就到位。所以**不能**拿它和旧 middleware 单层比 ——
 * 该比的是「够得着的东西有没有变多」。
 *
 * 最终可达性完全相等由 tests/rbac-route-map.test.ts 的 parity 保证；这里守的是
 * 更弱但更关键的一条：**位图路径永远不会放宽任何一格**。
 */
test('位图路径不会比旧体系的最终可达性更宽松', () => {
  const looser: string[] = []
  const oldMatrix = JSON.parse(readFileSync('lib/rbac/parity-baseline.json', 'utf-8')) as
    Record<string, Record<string, string>>
  for (const h of scanApiHandlers()) {
    const path = fillParams(h.route)
    if (isPublicApiRoute(path)) continue // 公开路由在 middleware 里先行放行，到不了 gate
    for (const role of bitmapOf.keys()) {
      const allowed = canAccessApi(newToken(role), path, h.verb)
      const reachableBefore = oldMatrix[`${h.verb} ${h.route}`]?.[role] === 'y'
      if (allowed && !reachableBefore) {
        looser.push(`${h.verb} ${h.route} [${role}]：以前够不着，现在够得着了`)
      }
    }
  }
  assert.deepEqual(looser.slice(0, 15), [], `有 ${looser.length} 格被放宽了`)
})

test('未在 route-map 登记的路由一律拒绝', () => {
  // 默认拒绝而不是默认放行：新增接口忘了登记的表现是 403（功能坏掉），
  // 而不是敞开（安全漏洞）。
  assert.ok(!canAccessApi(newToken('BOSS'), '/api/brand-new-endpoint', 'GET'))
  assert.ok(!canAccessApi(newToken('OPERATOR'), '/api/brand-new-endpoint', 'POST'))
  assert.ok(!canAccessPage(newToken('BOSS'), '/classic/brand-new-page'))
})

test('全 0 位图仍是新 token，且什么业务接口都够不着', () => {
  // 注意 encodePermissions([]) 编出来是一串 'AAA…' 而不是空串 —— 它是有效位图，
  // 只是每一位都是 0。所以「没有任何权限」与「旧 token」是两种不同的状态，
  // 不能靠字符串是否为空来区分。
  const zero = { role: 'OTHER', roles: ['OTHER'], pm: encodePermissions([]) }
  assert.ok(hasBitmap(zero), '全 0 位图必须被当成新 token，否则会误走回退路径而放权')
  assert.ok(!canAccessApi(zero, '/api/customers', 'GET'))
  assert.ok(!canAccessApi(zero, '/api/orders', 'GET'))
  // 无需权限的接口仍然放行（登录即可）
  assert.ok(canAccessApi(zero, '/api/notifications', 'GET'))

  const onlyFx = { role: 'OTHER', roles: ['OTHER'], pm: encodePermissions(['tool.fx.read']) }
  assert.ok(canAccessApi(onlyFx, '/api/fx-rate', 'GET'))
  assert.ok(!canAccessApi(onlyFx, '/api/customers', 'GET'))
})
