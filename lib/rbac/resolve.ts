/**
 * 权限解析：用户 → 生效权限集 + 数据范围
 * ============================================================================
 * 只在**登录时**跑一次（要查库），结果编成位图塞进 JWT。之后每次请求的判定
 * 都是纯位运算，不再查库 —— 这对 2 vCPU 的 droplet 很重要。
 *
 * 合成规则：
 *   权限 = (所有角色的权限点并集) ∪ (个人 granted) − (个人 revoked)
 *   范围 = 所有角色 dataScope 里**最宽**的那一档
 *
 * 为什么 dataScope 取最宽而不是最窄：现网 19 个 SALES 全部兼任 OPERATOR，
 * 取最窄会让他们突然只看得到自己的单 —— 那不是平迁，是把业务改了。
 */
import { prisma } from '@/lib/db'
import { encodePermissions } from './bitmap'
import { isKnownPermission } from './catalog'

export type DataScope = 'ALL' | 'TEAM' | 'OWN'

/** 越靠前越宽 */
const SCOPE_RANK: Record<DataScope, number> = { ALL: 0, TEAM: 1, OWN: 2 }

export function widestScope(scopes: readonly DataScope[]): DataScope {
  if (scopes.length === 0) return 'OWN' // 没有任何角色 → 给最窄的，不是最宽
  return scopes.reduce((a, b) => (SCOPE_RANK[b] < SCOPE_RANK[a] ? b : a))
}

export interface ResolvedPermissions {
  /** 权限点 id 集合 */
  permissions: string[]
  dataScope: DataScope
  /** base64url 位图，写进 JWT 的 `pm` */
  bitmap: string
  /** 写进 JWT 的 `pv`，与 User.permVersion 比对以决定是否强制重登 */
  permVersion: number
}

/** 纯函数版：给定角色与个人例外，算出生效权限。单测直接打这个，不碰数据库 */
export function combinePermissions(
  roles: ReadonlyArray<{ permissions: readonly string[]; dataScope: DataScope }>,
  grants: ReadonlyArray<{ permissionId: string; granted: boolean }> = [],
): { permissions: string[]; dataScope: DataScope } {
  const set = new Set<string>()
  for (const role of roles) {
    for (const id of role.permissions) if (isKnownPermission(id)) set.add(id)
  }
  // 个人例外后于角色生效：先加后减，所以同一个权限点上 revoke 压过 grant
  for (const g of grants) {
    if (!isKnownPermission(g.permissionId)) continue
    if (g.granted) set.add(g.permissionId)
  }
  for (const g of grants) {
    if (!g.granted) set.delete(g.permissionId)
  }
  return {
    permissions: [...set],
    dataScope: widestScope(roles.map((r) => r.dataScope)),
  }
}

/** 查库版：登录时调用 */
export async function resolveUserPermissions(userId: string): Promise<ResolvedPermissions> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      permVersion: true,
      roleLinks: { select: { role: { select: { permissions: true, dataScope: true } } } },
      permissionGrants: { select: { permissionId: true, granted: true } },
    },
  })
  if (!user) return { permissions: [], dataScope: 'OWN', bitmap: '', permVersion: 0 }

  const { permissions, dataScope } = combinePermissions(
    user.roleLinks.map((l) => ({
      permissions: l.role.permissions,
      dataScope: l.role.dataScope as DataScope,
    })),
    user.permissionGrants,
  )

  return {
    permissions,
    dataScope,
    bitmap: encodePermissions(permissions),
    permVersion: user.permVersion,
  }
}

/**
 * 权限变更后调用：bump 受影响用户的 permVersion，逼他们下次请求时重新登录。
 * 已定决策 5 —— 不做 token_stale 静默重签，代价是用户被踢出，可接受。
 */
export async function bumpPermVersion(userIds: readonly string[]): Promise<number> {
  if (userIds.length === 0) return 0
  const r = await prisma.user.updateMany({
    where: { id: { in: [...userIds] } },
    data: { permVersion: { increment: 1 } },
  })
  return r.count
}

/** 某个角色被改动后，受影响的是挂了这个角色的所有人 */
export async function usersOfRole(roleId: string): Promise<string[]> {
  const links = await prisma.userRoleLink.findMany({
    where: { roleId },
    select: { userId: true },
  })
  return links.map((l) => l.userId)
}
