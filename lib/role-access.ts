/**
 * 角色可达范围 —— 边界收窄型角色的唯一真相
 * ============================================================================
 * 这里管的是「**这个角色压根不该碰的区域**」，在 middleware 层一刀切；
 * 「这个角色能不能做某个具体动作」是 `withAuth` 的 allowedRoles 和
 * `lib/permissions.ts` 的 `can()` 管的，两者是不同粒度，都要有。
 *
 * 为什么要在 middleware 做而不是逐个路由加 allowedRoles：
 * 2026-08-06 审计实测，一个餐厅客户账号能读到 1,596 家客户的完整名册（含税号、
 * 信用额度、提成率）、500 张订单里 499 张是别家的、以及采购成本与供应商名录，
 * 还能 `POST /api/pricelists` 真的写进去。根因是 235 个 handler 里有 99 个
 * 没传 allowedRoles。**逐个补要改 100 处，漏一处就还是漏**；而外部角色的边界
 * 本来就该是「白名单之外全拒」，一处判定覆盖全部现有和将来新增的路由。
 *
 * 见 docs/20260806-rbac-audit-and-tasks.md
 */

/**
 * 外部角色 → 允许访问的 API 前缀白名单。
 *
 * ⛔ 只列**确实需要**的。往这里加一条之前先问：外部的人拿到这个接口的数据，
 * 会不会看到别的客户 / 成本 / 内部配置？
 */
export const EXTERNAL_ROLE_API_ALLOWLIST: Record<string, readonly string[]> = {
  /**
   * 餐馆客户：只能通过订购页面看**属于自己的价格**的商品，别的一律不可见，
   * 也不能登录运营后台（2026-08-06 用户明确定的边界）。
   *
   * `/api/customer-portal/*` 三个路由都已按 customerId 做行级隔离，
   * 且 products 只回 customerPrice，不回 standardPrice / listPrice / commissionPrice。
   */
  RESTAURANT: [
    '/api/customer-portal',
    '/api/auth',          // 登录、改密码、登出
    '/api/health',
    '/api/notifications', // 自己的通知
  ],
}

/**
 * 外部角色 → 允许访问的页面前缀（去掉 locale 前缀后的路径）。
 * 其余一律踢回自己的主页，而不是让他们看到运营后台的空壳页面。
 */
export const EXTERNAL_ROLE_PAGE_ALLOWLIST: Record<string, readonly string[]> = {
  RESTAURANT: ['/customer-portal', '/enter'],
}

/** 该角色是否属于「边界收窄」型（在白名单外一律拒绝） */
export function isExternalRole(roles: string[]): string | null {
  for (const r of roles) {
    if (r in EXTERNAL_ROLE_API_ALLOWLIST) return r
  }
  return null
}

/** 前缀匹配，且必须匹配到完整路径段 —— 避免 `/api/authorize` 被 `/api/auth` 放行 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/** 外部角色能否访问这个 API 路径 */
export function canExternalRoleAccessApi(role: string, pathname: string): boolean {
  const allow = EXTERNAL_ROLE_API_ALLOWLIST[role]
  if (!allow) return true          // 不是受限角色，这一层不管
  return allow.some((p) => matchesPrefix(pathname, p))
}

/** 外部角色能否访问这个页面路径（已去掉 locale 前缀） */
export function canExternalRoleAccessPage(role: string, barePath: string): boolean {
  const allow = EXTERNAL_ROLE_PAGE_ALLOWLIST[role]
  if (!allow) return true
  if (barePath === '/') return true
  return allow.some((p) => matchesPrefix(barePath, p))
}

/** 受限角色被拦下后该去哪 */
export const EXTERNAL_ROLE_HOME: Record<string, string> = {
  RESTAURANT: '/customer-portal',
}
