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

/**
 * 允许「导出比列表严」，但必须在这里显式登记并写清为什么：那意味着某个角色
 * 接口上读得到列表却导不出，必须确认它在**界面上根本碰不到导出按钮**，
 * 否则就是又一个「点了 403、没人知道为什么」的静默失效。
 */
const KNOWN_STRICTER: Record<string, { roles: string[]; why: string }> = {
  orders: {
    roles: ['SORTER'],
    why: '分拣台内部调 /api/orders 取数（route-map 给 GET 放行了 stock.quality.read/'
      + 'stock.pick.read），但 SORTER 的页面范围只有 /classic/sorter，够不到报价单/'
      + '销售单列表页，界面上不存在导出按钮。导出保持只要 sales.order.read。',
  },
}

test('旧 token：能读列表的角色都够得着对应的导出入口', () => {
  const broken: string[] = []
  for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
    const allowed = new Set(KNOWN_STRICTER[entity]?.roles ?? [])
    for (const role of PROBE_ROLES) {
      if (allowed.has(role)) continue
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

/**
 * 上面那条只测了旧 token 的 middleware 白名单。新 token 走的是权限点，
 * 两层判据不同 —— 度量工具自己有盲区，这条补上。KNOWN_STRICTER 声明在文件顶部，
 * 两条测试共用同一份登记。
 */
test('新 token：导出的可达角色不多于列表，少的必须是登记过的例外', async () => {
  const { buildReachabilityMatrix } = await import('../lib/role-reachability')
  const matrix = buildReachabilityMatrix()
  const problems: string[] = []

  for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
    const list = matrix[`GET ${meta.listApi}`]
    const exp = matrix[`GET /api/export/${entity}`]
    if (!list || !exp) { problems.push(`${entity}: 矩阵里找不到列表或导出`); continue }
    const allowed = new Set(KNOWN_STRICTER[entity]?.roles ?? [])
    for (const role of Object.keys(list)) {
      if (exp[role] === 'y' && list[role] !== 'y') {
        problems.push(`${entity}: ${role} 导得出却读不了列表 —— 导出不能比列表开放`)
      }
      if (list[role] === 'y' && exp[role] !== 'y' && !allowed.has(role)) {
        problems.push(`${entity}: ${role} 读得了列表却导不出，且不在 KNOWN_STRICTER 里`)
      }
    }
  }
  assert.deepEqual(problems, [])
})
