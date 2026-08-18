/**
 * ⛔ 不变量：**能读某个列表的角色，就能导出这个列表**。
 *
 * 守的是一类不会报错的故障：导出是个新动作，middleware 的旧角色白名单
 * （lib/role-access.ts）里如果只登记了列表接口、没登记导出接口，收窄型角色
 * （WAREHOUSE / SALES / EXTERNAL_SALES…）拿旧 token 时表现是「列表看得见、
 * 点导出 403」。功能对这些人静默中断，没有任何测试或日志会提示。
 * 2026-08-07 已经因为同类问题（拆细子动作没补给原角色）踩过一次。
 *
 * 新增可导出实体时，这条测试会替你检查白名单是不是也跟着加了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPORT_ENTITY_META } from '../lib/export/entities'
import { canAccessApi } from '../lib/rbac/gate'
import { PROBE_ROLES } from '../lib/role-reachability'
import { API_ROUTE_RULES, requiredPermissionsFor } from '../lib/rbac/route-map'

test('旧 token：能读列表的角色都够得着对应的导出入口', () => {
  const broken: string[] = []
  for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
    for (const role of PROBE_ROLES) {
      const session = { role, roles: [role] }   // 没有 pm = 旧 token，走角色白名单回退
      const canList = canAccessApi(session, meta.listApi, 'GET')
      const canExport = canAccessApi(session, `/api/export/${entity}`, 'GET')
      if (canList && !canExport) {
        broken.push(`${role} 能读 ${meta.listApi} 却导不出 ${entity}`)
      }
    }
  }
  assert.deepEqual(broken, [], '这些角色的旧 token 会「列表看得见、导出 403」')
})

test('每个可导出实体都在 route-map 里登记了，且权限点与其列表一致', () => {
  const bad: string[] = []
  for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
    const required = requiredPermissionsFor(API_ROUTE_RULES, `/api/export/${entity}`, 'GET')
    if (required === undefined) { bad.push(`${entity} 没有 route-map 规则，会全员 403`); continue }
    if (required === null) { bad.push(`${entity} 被登记成无需权限 —— 导出不能是公开的`); continue }
    if (!required.includes(meta.permission)) {
      bad.push(`${entity} 的 route-map 权限 ${required.join('/')} 与 entities.ts 声明的 ${meta.permission} 不一致`)
    }
  }
  assert.deepEqual(bad, [])
})

test('导出不会比它的列表更开放', () => {
  const wider: string[] = []
  for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
    const listPerms = requiredPermissionsFor(API_ROUTE_RULES, meta.listApi, 'GET')
    if (!Array.isArray(listPerms)) continue
    // 导出要的权限点必须是列表所需权限点之一 —— 不能出现「看不了列表却能导出全量」
    if (!listPerms.includes(meta.permission)) {
      wider.push(`${entity}: 导出要 ${meta.permission}，而列表要 ${listPerms.join('/')}`)
    }
  }
  assert.deepEqual(wider, [])
})
