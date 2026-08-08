/**
 * 权限管理的服务端逻辑（供 /api/rbac/* 使用）
 * ============================================================================
 * 这里放两类东西：
 *   1. 校验 —— 权限点必须真实存在、系统角色不可删、**不能把自己锁在门外**
 *   2. 生效 —— 改完之后 bump 受影响用户的 permVersion，逼他们重新登录
 *
 * 已定决策 5：不做 token_stale 静默重签，改完就踢。代价是用户被踢出，可接受。
 */
import { prisma } from '@/lib/db'
import { isKnownPermission, PERMISSIONS } from './catalog'
import { forgetPermVersions } from './perm-version'

/** 拥有这个权限点的人可以改任何人的权限 —— 系统里必须始终至少有一个 */
export const RBAC_ADMIN_PERMISSION = 'system.rbac.manage'

export class RbacError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** 权限点 id 列表：去重、去掉 catalog 里不存在的，并报出哪些被丢了 */
export function sanitizePermissions(input: unknown): { ids: string[]; unknown: string[] } {
  const raw = Array.isArray(input) ? input.map(String) : []
  const ids: string[] = []
  const bad: string[] = []
  for (const id of new Set(raw)) {
    if (isKnownPermission(id)) ids.push(id)
    else bad.push(id)
  }
  // 按 catalog 顺序排，让存进库的数组稳定 —— 否则每次保存 diff 都是一片红
  const order = new Map(PERMISSIONS.map((p, i) => [p.id, i]))
  ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return { ids, unknown: bad }
}

export function assertValidScope(scope: unknown): 'ALL' | 'TEAM' | 'OWN' {
  if (scope === 'ALL' || scope === 'TEAM' || scope === 'OWN') return scope
  throw new RbacError('数据范围只能是 ALL / TEAM / OWN')
}

/**
 * ⛔ 防锁死：任何一次改动之后，系统里必须还剩至少一个**活跃**账号拥有
 * `system.rbac.manage`。否则一次误操作就没人能再改权限了 —— 只能改数据库救场。
 *
 * 在事务提交**之后**校验没有意义（那时已经锁死了），所以调用方要在事务里跑它，
 * 校验不过就整体回滚。
 */
export async function assertAdminSurvives(
  tx: Pick<typeof prisma, 'user'>,
  hint: string,
): Promise<void> {
  const survivors = await (tx as typeof prisma).user.count({
    where: {
      isActive: true,
      OR: [
        {
          roleLinks: {
            some: { role: { permissions: { has: RBAC_ADMIN_PERMISSION } } },
          },
        },
        {
          permissionGrants: {
            some: { permissionId: RBAC_ADMIN_PERMISSION, granted: true },
          },
        },
      ],
      // 被个人级例外显式收回的不算
      NOT: {
        permissionGrants: {
          some: { permissionId: RBAC_ADMIN_PERMISSION, granted: false },
        },
      },
    },
  })
  if (survivors === 0) {
    throw new RbacError(
      `${hint}之后，系统里将没有任何活跃账号能管理权限 —— 这一步会把所有人锁在门外，已阻止。` +
        `请先给另一个账号授予「系统管理 — 角色与权限 — 管理」再重试。`,
      409,
    )
  }
}

/**
 * 权限变更后作废这些人手里的 token（下次请求 401 → 重新登录）。
 *
 * 顺带清掉本进程的 permVersion 缓存 —— 不清的话，判定要等缓存自然过期（≤30s）
 * 才生效，管理员改完立刻去验证会看到「怎么还没踢」。
 */
export async function invalidateTokens(
  tx: Pick<typeof prisma, 'user'>,
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0
  const r = await (tx as typeof prisma).user.updateMany({
    where: { id: { in: [...userIds] } },
    data: { permVersion: { increment: 1 } },
  })
  forgetPermVersions(userIds)
  return r.count
}

/** 挂了某个角色的全部用户 */
export async function userIdsOfRole(
  tx: Pick<typeof prisma, 'userRoleLink'>,
  roleId: string,
): Promise<string[]> {
  const links = await (tx as typeof prisma).userRoleLink.findMany({
    where: { roleId },
    select: { userId: true },
  })
  return links.map((l) => l.userId)
}
