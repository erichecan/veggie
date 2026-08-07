/**
 * 静态可达性矩阵：每个 API handler，各角色够不够得着。
 * ============================================================================
 * 把三层判定合成一张表，**不需要跑起服务、不需要数据库**，所以能进 CI：
 *   1. middleware 的公开白名单（lib/public-routes.ts）
 *   2. middleware 的角色边界（lib/role-access.ts）
 *   3. 路由自己的 allowedRoles（lib/route-gate-scan.ts 扫出来）
 *
 * 它管不了的：行级隔离（能看到几条）与业务态校验。那两层由
 * tests/row-scope.test.ts 与端到端实测覆盖。
 *
 * 用途是 diff：任何一次改动只要让某个角色够到了原先够不着的接口，
 * 快照比对就会红，并把变化逐格列出来。审计那次的教训是
 * **白名单加错了没有任何测试会红**，这张表就是补那个洞。
 */
import { scanApiHandlers } from './route-gate-scan'
import { canRolesAccessApi } from './role-access'
import { isPublicApiRoute } from './public-routes'

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
export function reachabilityFor(
  route: string, verb: string, gateRoles: string[] | null,
): Record<string, Reach> {
  const path = fillParams(route)
  const out: Record<string, Reach> = {}
  for (const role of PROBE_ROLES) {
    if (isPublicApiRoute(path)) { out[role] = 'anon'; continue }
    const passesScope = canRolesAccessApi([role], path, verb)
    const passesGate = !gateRoles || gateRoles.includes(role)
    out[role] = passesScope && passesGate ? 'y' : 'n'
  }
  return out
}

export function buildReachabilityMatrix(): Record<string, Record<string, Reach>> {
  const matrix: Record<string, Record<string, Reach>> = {}
  for (const h of scanApiHandlers()) {
    const gateRoles = h.gate.kind === 'roles' ? h.gate.roles : null
    matrix[`${h.verb} ${h.route}`] = reachabilityFor(h.route, h.verb, gateRoles)
  }
  return matrix
}
