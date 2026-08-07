/**
 * 旧 token 的回退判定：权限点 → 拥有它的角色。
 * ============================================================================
 * ⛔ 这个文件是为了修一个实测到的生产问题：
 *
 * T5 把 154 个 handler 的闸门从 `allowedRoles` 改成了 `{ require: '权限点' }`，
 * 而权限点只存在于**新 token 的位图**里。部署那一刻所有在线用户手里都是没有 `pm`
 * 的旧 token（7 天有效期），于是 `decodePermissions(undefined)` 得到空集 ——
 * **这 154 个接口对所有还没重新登录的人全部 403**。
 * 生产实测：RESTAURANT 的旧 token 打 /api/customer-portal/products 返回 403，
 * 被挡在了自己的门户外面。
 *
 * 修法不能是「没有位图就跳过权限检查」—— 那样旧 token 只剩 middleware 一层边界，
 * 比改造前**更宽松**（例如 OPERATOR 能调原本只给 BOSS 的接口）。
 *
 * 正确做法是反查：每个权限点对应「改造前哪些角色拥有它」。因为权限点本身就是从
 * 改造前的可达性反推出来的（见 scripts/rbac/derive-system-roles.ts），
 * 所以这张反查表等价于原来的 allowedRoles，旧 token 的行为与改造前完全一致。
 *
 * 这个文件可以在全部旧 token 过期后删掉（部署日 + 7 天）。
 */
import seed from '../../prisma/seed-rbac.json'

/** 权限点 → 改造前拥有它的角色集合 */
const ROLES_BY_PERMISSION: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>()
  for (const role of seed.roles) {
    for (const id of role.permissions) {
      let set = map.get(id)
      if (!set) { set = new Set(); map.set(id, set) }
      set.add(role.legacyRole)
    }
  }
  return map
})()

/**
 * 旧 token 判定：这些角色里，有没有谁在改造前就拥有所需权限点之一。
 *
 * 权限点在反查表里查不到（catalog 里新加的、还没进 seed 的）时返回 false ——
 * 宁可让旧 token 用户重新登录，也不放行一个来历不明的权限。
 */
export function legacyRolesHavePermission(
  roles: readonly string[],
  required: readonly string[],
): boolean {
  return required.some((id) => {
    const owners = ROLES_BY_PERMISSION.get(id)
    return owners ? roles.some((r) => owners.has(r)) : false
  })
}
