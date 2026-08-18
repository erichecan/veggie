/**
 * 静态可达性矩阵：每个 API handler，各角色够不够得着。
 * ============================================================================
 * 把各层判定合成一张表，**不需要跑起服务、不需要数据库**，所以能进 CI：
 *   1. middleware 的公开白名单（lib/public-routes.ts）
 *   2. middleware 的权限判定（lib/rbac/route-map.ts + 角色权限集）
 *   3. 路由自己的闸门（lib/route-gate-scan.ts 扫出来）
 *
 * 20260807 起判定真相是**权限点**，不再是角色。角色只是「一组权限点」的名字，
 * 所以这里先把角色翻成权限集（prisma/seed-rbac.json），再按权限点判。
 * 过渡期还剩几处 allowedRoles 写法的话，仍按角色判 —— 两种 gate 并存是有意的。
 *
 * 它管不了的：行级隔离（能看到几条）与业务态校验。那两层由
 * tests/row-scope.test.ts 与端到端实测覆盖。
 *
 * 用途是 diff：任何一次改动只要让某个角色够到了原先够不着的接口，
 * 快照比对就会红，并把变化逐格列出来。审计那次的教训是
 * **白名单加错了没有任何测试会红**，这张表就是补那个洞。
 */
import { readFileSync } from 'node:fs'
import { scanApiHandlers, type Gate } from './route-gate-scan'
import { isPublicApiRoute } from './public-routes'
import { API_ROUTE_RULES, requiredPermissionsFor } from './rbac/route-map'
import { EXPORT_ENTITY_META } from './export/entities'

/** 角色 → 权限点集合。来自 T1 的反推结果，由 scripts/rbac/derive-system-roles.ts 生成 */
const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf8')) as {
  roles: Array<{ legacyRole: string; permissions: string[] }>
}
const PERMS_BY_ROLE = new Map(seed.roles.map((r) => [r.legacyRole, new Set(r.permissions)]))

/** 被测角色。与 prisma enum Role 一致（tests/role-definitions-sync.test.ts 保证不漂）。 */
export const PROBE_ROLES = [
  'BOSS', 'OPERATOR', 'FINANCE', 'WAREHOUSE', 'DISPATCH',
  'SALES', 'EXTERNAL_SALES', 'SORTER', 'PICKER', 'DRIVER',
  'RESTAURANT', 'OTHER',
] as const

/** 动态段填成一个普通段：段级匹配下 `[id]` 与真实 id 等价 */
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'x')

export type Reach = 'anon' | 'y' | 'n'

/** 一个 handler 上，各角色的可达性 */
export function reachabilityFor(route: string, verb: string, gate: Gate): Record<string, Reach> {
  const path = fillParams(route)
  const out: Record<string, Reach> = {}
  const required = requiredPermissionsFor(API_ROUTE_RULES, path, verb)

  for (const role of PROBE_ROLES) {
    if (isPublicApiRoute(path)) { out[role] = 'anon'; continue }
    const perms = PERMS_BY_ROLE.get(role) ?? new Set<string>()

    // middleware 层：route-map 未登记的路由一律拒绝（不是放行）
    const passesMiddleware =
      required === undefined ? false
      : required === null ? true
      : required.some((p) => perms.has(p))

    // 路由自身的闸：权限点写法按权限判，遗留的角色写法按角色判
    const passesGate =
      gate.kind === 'permission' ? gate.permissions.some((p) => perms.has(p))
      : gate.kind === 'roles' ? gate.roles.includes(role)
      : true

    out[role] = passesMiddleware && passesGate ? 'y' : 'n'
  }
  return out
}

/** 导出统一入口：权限随 entity 而变，不能当成一个端点探测（见 probeRoutes） */
const EXPORT_ROUTE = '/api/export/[entity]'

export interface ProbeRoute {
  /** 矩阵/基线里的行标识 */
  key: string
  /** 动态段已填充的可匹配路径 */
  path: string
  verb: string
  gate: Gate
}

/**
 * 待探测的路由清单 —— 扫描结果 + 必要的动态段展开。
 *
 * `/api/export/[entity]` 必须展开：它的权限点是运行时按 entity 从
 * lib/export/entities.ts 取的（`{ require: meta.permission }`），
 * 而扫描器只认字面量，会把它读成 authOnly；把 [entity] 填成 x 又匹配不到任何
 * route-map 规则，探测结果是"全员不可达"。两种失真叠在一起，等于这张表
 * 对导出接口完全失明 —— 将来谁把某个实体的权限改松了，快照不会红。
 * 展开成「每个实体一行、gate 取它自己的权限点」之后，表才说的是实话。
 */
export function probeRoutes(): ProbeRoute[] {
  const out: ProbeRoute[] = []
  for (const h of scanApiHandlers()) {
    if (h.route === EXPORT_ROUTE) {
      for (const [entity, meta] of Object.entries(EXPORT_ENTITY_META)) {
        const path = `/api/export/${entity}`
        out.push({
          key: `${h.verb} ${path}`,
          path,
          verb: h.verb,
          gate: { kind: 'permission', permissions: [meta.permission] },
        })
      }
      continue
    }
    out.push({ key: `${h.verb} ${h.route}`, path: fillParams(h.route), verb: h.verb, gate: h.gate })
  }
  return out
}

export function buildReachabilityMatrix(): Record<string, Record<string, Reach>> {
  const matrix: Record<string, Record<string, Reach>> = {}
  for (const r of probeRoutes()) {
    matrix[r.key] = reachabilityFor(r.path, r.verb, r.gate)
  }
  return matrix
}
