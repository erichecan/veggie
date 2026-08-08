/**
 * 权限版本号校验 —— 「权限变更后强制重新登录」的执行点。
 * ============================================================================
 * 决策 5 定的是：改了谁的权限，就作废谁手里的 token，不做静默重签。
 * 作废的方式是 `User.permVersion + 1`；token 里带着签发时的 `pv`。
 * 两者对不上，说明这张 token 描述的权限已经过时 —— 它的位图可能比现在更宽。
 *
 * ⚠️ 为什么要缓存：`withAuth` 原本零次查库，纯验签。每个请求加一次
 * `SELECT permVersion` 在 2 vCPU 的机器上不是可以忽略的开销
 * （见记忆「droplet 性能与容灾」：瓶颈是 CPU，8 并发即饱和）。
 *
 * 缓存的代价是**最长 30 秒的滞后**：改完权限到对方真的被踢，中间可能隔半分钟。
 * 这是有意接受的 —— 权限收窄不是安全事件响应，半分钟够用。
 * 单进程部署（现网 droplet 就是）下其实没有滞后：改权限的那几个 `/api/rbac/*`
 * 接口会调 `forgetPermVersions()` 就地清掉缓存，下一个请求立刻查库。
 */
import { prisma } from '@/lib/db'

const TTL_MS = 30_000

const cache = new Map<string, { version: number; expiresAt: number }>()

/** 改完权限立刻清掉这些人的缓存，让下一个请求马上看到新版本号 */
export function forgetPermVersions(userIds: readonly string[]): void {
  for (const id of userIds) cache.delete(id)
}

/** 测试用：清空整张表 */
export function resetPermVersionCache(): void {
  cache.clear()
}

async function currentPermVersion(userId: string, now: number): Promise<number | null> {
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > now) return hit.version

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { permVersion: true },
  })
  if (!row) return null
  cache.set(userId, { version: row.permVersion, expiresAt: now + TTL_MS })
  return row.permVersion
}

/**
 * token 是否已经因为权限变更而作废。
 *
 * 只在 token 带着 `pv` 时才判。旧 token 没有这个字段 —— 对它们返回 false 是对的：
 * 旧 token 走的是 `legacy-roles` 角色反查，权限本来就锁在改造前的口径上，
 * 不会因为管理员改了某个 AppRole 而变宽。硬把它们判成过期，
 * 等于在部署当天把所有在线用户踢下线一遍。
 */
export async function isTokenRevoked(
  payload: { userId?: string; pv?: number },
  now = Date.now(),
): Promise<boolean> {
  if (typeof payload.pv !== 'number' || !payload.userId) return false
  const current = await currentPermVersion(payload.userId, now)
  if (current === null) return false          // 用户查不到：交给业务层去处理，不在这里判死
  return current > payload.pv
}
