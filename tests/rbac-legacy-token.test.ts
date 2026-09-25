import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { legacyRolesHavePermission } from '../lib/rbac/legacy-roles'
import { canAccessApi } from '../lib/rbac/gate'
import { isPublicApiRoute } from '../lib/public-routes'
import { probeRoutes, PROBE_ROLES, type Reach } from '../lib/role-reachability'
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
/**
 * 旧 token 与基线之间**允许存在**的差异。
 *
 * 只有一种情形能进这张表：那次权限发放的迁移自己 bump 了 permVersion，
 * 把受影响的人当场踢下线。旧 token 因此不存在，也就谈不上「没重新登录的人
 * 功能坏掉」—— 这条测试要防的场景不成立。
 *
 * ⚠️ 不是「测试红了就往这里加一条」。加之前必须能指出是哪条迁移、哪一段 SQL
 * 做的 permVersion bump；指不出来的，就是真的有人会看到功能坏掉。
 */
const LEGACY_TOKEN_EXEMPT: Record<string, string> = {
  // 20260913000002_sales_order_manage_adjustment：把 sales.order.manage_adjustment
  // 发给所有持有 sales.order.update 的角色（生产实测 boss/operator/sales/external_sales
  // 四个角色都拿到了），同一条迁移末尾 UPDATE "User" SET "permVersion" = "permVersion" + 1
  // 踢掉了这些角色下的全部用户。
  // 旧体系的角色边界（role-access.ts ROLE_API_SCOPE）对 SALES / EXTERNAL_SALES 只放行
  // /api/orders/** 的 GET/POST/PUT/PATCH，不含 DELETE —— 所以只有旧 token 这条路径判 n。
  'DELETE /api/orders/[id]/adjustments/[adjustmentId] [SALES]':
    '20260913000002 发权限时已 bump permVersion 强制重登，旧 token 不存在',
  'DELETE /api/orders/[id]/adjustments/[adjustmentId] [EXTERNAL_SALES]':
    '同上',
  // 20260922000002_stock_pick_split_lock_unlock：新增 stock.pick.lock，发给
  // boss/operator/sales/external_sales（= page.operator.access 的受众），
  // 同一条迁移末尾 bump 了这四个角色下所有用户的 permVersion。
  // 旧体系的角色边界（role-access.ts ROLE_API_SCOPE）里 SALES 对 /api/waves/**
  // 只放行 print-status 和列表 GET，不含 pick-lock —— 所以只有旧 token 这条路径判 n。
  'POST /api/waves/[id]/pick-lock [SALES]':
    '20260922000002 发权限时已 bump permVersion 强制重登，旧 token 不存在',
  'POST /api/waves/[id]/pick-lock [EXTERNAL_SALES]':
    '同上',
  // 20260923001437_return_flow_permissions：WAREHOUSE 新增 dispatch.trip.warehouse_verify/
  // read/read_returns，SALES 新增 dispatch.trip.read_returns/returns，migration 末尾对
  // warehouse、sales 两个角色下的全部用户 bump 了 permVersion 强制重登，旧 token 不存在。
  'GET /api/customers/coordinates [WAREHOUSE]': '20260923001437 发权限时已 bump permVersion 强制重登，旧 token 不存在',
  'GET /api/trips/[id] [WAREHOUSE]': '同上',
  'GET /api/trips [WAREHOUSE]': '同上',
  'GET /api/trips/[id]/returns [WAREHOUSE]': '同上',
  'PUT /api/trips/[id]/returns/warehouse-verify [WAREHOUSE]': '同上',
  'GET /api/trips/[id]/returns [SALES]': '同上',
  'PUT /api/trips/[id]/returns [SALES]': '同上',
  'POST /api/trips/[id]/returns [SALES]': '同上',
  // 20260923002138_return_report_permission：DRIVER 新增 dispatch.trip.report_return，
  // migration 末尾对 driver 角色下的全部用户 bump 了 permVersion 强制重登，旧 token 不存在。
  'POST /api/trips/[id]/returns [DRIVER]':
    '20260923002138 发权限时已 bump permVersion 强制重登，旧 token 不存在',
  // 20260924000002_accounting_writeoff_permissions：finance.write_off.* 发给
  // boss/operator/finance，顺带修了 /api/orders/bulk 外层闸门此前漏挂 FINANCE 的问题
  // （闸门加入 finance.write_off.confirm 任一即可）。migration 末尾对
  // boss/operator/finance/driver 四个角色下的全部用户 bump 了 permVersion 强制重登，
  // 旧 token 不存在。
  'POST /api/orders/bulk [FINANCE]':
    '20260924000002 发权限时已 bump permVersion 强制重登，旧 token 不存在',
}

/** 逐格比对旧 token 的最终可达性与基线，返回全部差异（不过滤例外） */
function legacyTokenDiffs(): Array<{ cell: string; detail: string }> {
  const diffs: Array<{ cell: string; detail: string }> = []

  for (const { key, path, verb, gate } of probeRoutes()) {
    if (isPublicApiRoute(path)) continue

    for (const role of PROBE_ROLES) {
      // 第一层：middleware（旧 token 走角色白名单回退）
      const passMiddleware = canAccessApi({ role, roles: [role] }, path, verb)

      // 第二层：路由自身的闸。旧 token 没有位图，权限点闸走角色反查
      const passGate =
        gate.kind === 'permission' ? legacyRolesHavePermission([role], gate.permissions)
        : gate.kind === 'roles' ? gate.roles.includes(role)
        : true

      const now: Reach = passMiddleware && passGate ? 'y' : 'n'
      const before = baseline[key]?.[role]
      if (before !== now) {
        diffs.push({
          cell: `${key} [${role}]`,
          detail: `${key} [${role}]: 改造前 ${before} → 旧 token 现在 ${now}`,
        })
      }
    }
  }
  return diffs
}

test('旧 token 的最终可达性与改造前基线逐格相同', () => {
  const diffs = legacyTokenDiffs()
    .filter(d => !(d.cell in LEGACY_TOKEN_EXEMPT))
    .map(d => d.detail)

  assert.deepEqual(
    diffs.slice(0, 20),
    [],
    `旧 token 的可达性变了 ${diffs.length} 格 —— 部署后没重新登录的人会看到功能坏掉或越权`,
  )
})

test('旧 token 例外表没有烂掉（差异消失了就删掉那条登记）', () => {
  const actual = new Set(legacyTokenDiffs().map(d => d.cell))
  for (const cell of Object.keys(LEGACY_TOKEN_EXEMPT)) {
    assert.ok(actual.has(cell), `例外表里的 ${cell} 已经没有差异了，请删掉这条登记`)
  }
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
