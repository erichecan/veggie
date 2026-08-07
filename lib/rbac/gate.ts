/**
 * middleware 用的判定入口（Edge runtime 安全 —— 不引入 Prisma）
 * ============================================================================
 * 过渡期同时支持两种 token：
 *   - 带 `pm` 位图的新 token  → 按权限点判定（route-map）
 *   - 不带 `pm` 的旧 token    → 回退到角色白名单（lib/role-access.ts）
 *
 * ⛔ 回退这条路径不能省。部署那一刻，所有在线用户手里都是旧 token（有效期 7 天），
 * 直接按位图判会把**全员**挡在门外 —— 包括没法登录进去改配置的管理员。
 *
 * 回退路径可以在全部旧 token 过期后删掉（部署日 + 7 天），
 * 删的时候把 lib/role-access.ts 一起删。
 */
import { decodePermissions } from './bitmap'
import { API_ROUTE_RULES, PAGE_ROUTE_RULES, requiredPermissionsFor } from './route-map'
import { canRolesAccessApi, canRolesAccessPage } from '../role-access'

/** jose 的 JWTPayload 是索引签名类型，所以这里也用索引签名，避免调用点到处断言 */
export interface TokenClaims {
  [claim: string]: unknown
  role?: unknown
  roles?: unknown
  pm?: unknown
}

/** 与 lib/auth.ts 的 effectiveRoles 同口径：roles[] 优先，空则回退单 role */
export function rolesOf(payload: TokenClaims): string[] {
  const arr = Array.isArray(payload.roles) ? payload.roles.filter(Boolean).map(String) : []
  if (arr.length > 0) return arr
  return payload.role ? [String(payload.role)] : []
}

/** token 里有没有权限位图。没有 = 旧 token，走兼容路径 */
export function hasBitmap(payload: TokenClaims): boolean {
  return typeof payload.pm === 'string' && payload.pm.length > 0
}

export function canAccessApi(payload: TokenClaims, pathname: string, method: string): boolean {
  if (!hasBitmap(payload)) return canRolesAccessApi(rolesOf(payload), pathname, method)

  const required = requiredPermissionsFor(API_ROUTE_RULES, pathname, method)
  // 未登记的路由一律拒绝。新增接口忘了在 route-map 里登记的表现是 403（功能坏掉），
  // 而不是敞开（安全漏洞）—— 这与旧的默认放行语义相反，是有意为之。
  if (required === undefined) return false
  if (required === null) return true
  return decodePermissions(payload.pm as string).hasAny(required)
}

export function canAccessPage(payload: TokenClaims, barePath: string): boolean {
  if (!hasBitmap(payload)) return canRolesAccessPage(rolesOf(payload), barePath)

  const required = requiredPermissionsFor(PAGE_ROUTE_RULES, barePath, 'GET')
  if (required === undefined) return false
  if (required === null) return true
  return decodePermissions(payload.pm as string).hasAny(required)
}
