/**
 * 页面守卫：layout 用来判断「当前会话能不能进这个页面」。
 * ============================================================================
 * 取代各 layout 里手写的 `['FINANCE','OPERATOR','BOSS'].includes(user.role)`。
 *
 * 那种写法有两个毛病：
 *   1. 看的是 `user.role` 单值，多角色账号（现网 19 个 SALES 兼 OPERATOR）
 *      只按主角色判，兼任的那个角色白兼了
 *   2. 每加一个岗位就要回来改 9 个文件，而且改漏了没有任何东西会报错
 *
 * 现在统一按权限点判，权限点来自 `lib/rbac/route-map.ts` 的页面规则 ——
 * 与 middleware 用的是同一张表，不会出现「middleware 放行但 layout 踢人」。
 *
 * ⚠️ 这只是体验层：middleware 已经在服务端挡过一道了。layout 这层是为了
 * 避免页面先闪一下再跳走。
 */
import { decodePermissions } from './bitmap'
import { PAGE_ROUTE_RULES, requiredPermissionsFor } from './route-map'

export interface GuardSession {
  role?: string | null
  roles?: string[] | null
  pm?: string | null
}

/**
 * @param pagePath 去掉 locale 前缀的路径，如 `/classic/finance/statements`
 * @param legacyRoles 旧口径的兜底角色名单。会话里没有位图时（旧登录态）按它判，
 *                    行为与改造前一致 —— 少了这个，部署后没重新登录的人会被自己的页面踢出去
 */
export function canEnterPage(
  session: GuardSession | null | undefined,
  pagePath: string,
  legacyRoles: readonly string[],
): boolean {
  if (!session) return false

  if (typeof session.pm === 'string' && session.pm.length > 0) {
    const required = requiredPermissionsFor(PAGE_ROUTE_RULES, pagePath, 'GET')
    if (required === undefined) return false
    if (required === null) return true
    return decodePermissions(session.pm).hasAny(required)
  }

  // 旧会话回退：roles[] 优先，空则回退单 role（与 lib/auth.ts 的 effectiveRoles 同口径）。
  // 顺带修掉了老写法只看 user.role 的毛病 —— 兼任角色现在也算数。
  const own =
    Array.isArray(session.roles) && session.roles.length > 0
      ? session.roles.map(String)
      : session.role
        ? [String(session.role)]
        : []
  return own.some((r) => legacyRoles.includes(r))
}
