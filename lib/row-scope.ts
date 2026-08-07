/**
 * 行级数据隔离 —— 「这个人能看到谁的数据」的唯一真相
 * ============================================================================
 * 与 `lib/role-access.ts`（能不能碰这个接口）、`withAuth` 的 allowedRoles
 * （能不能做这个动作）是三层不同的东西，缺一层都不够：
 *   接口能进 + 动作能做 + **只能看到自己的** = 完整的边界。
 *
 * 为什么单独一个文件：这类条件写在各路由里，隔一段时间就会漏一处，
 * 而漏了不会报错、只会静默多给数据。已经踩过两次：
 *   20260802 `/api/customers` 的条件 push 在 where 构造**之后**，
 *            where 退化成 {} 时整段失效；
 *   20260806 `buildOrdersWhere` 里写成 `if (!salesUserId)` ——
 *            只要请求带上 `?salesUserId=别人的id`，隔离整段被跳过。
 * 两次都是"条件在某个分支下被丢掉"。所以这里只暴露**不可绕过**的合并函数。
 */

export interface ScopeCaller {
  userId: string
  role?: string | null
  roles?: string[] | null
}

/** 与 lib/auth.ts effectiveRoles 同口径：roles[] 优先，空则回退单 role */
function rolesOf(caller: ScopeCaller): string[] {
  const arr = Array.isArray(caller.roles) ? caller.roles.filter(Boolean).map(String) : []
  if (arr.length > 0) return arr
  return caller.role ? [String(caller.role)] : []
}

/**
 * 按业务员归属隔离（Customer.salesUserId / Order.salesUserId）。
 * 返回 null 表示不隔离。
 *
 * 两类销售的差别是 2026-08-06 用户的决策：
 *
 * - **EXTERNAL_SALES（外部合作销售）**：**无条件隔离**。他是公司外部的人，
 *   哪怕账号上还挂着别的角色也不放行 —— 那种组合只可能是配错了，宁可挡住。
 *
 * - **SALES（正式员工）**：兼任 OPERATOR/BOSS 时不隔离。
 *   ⚠️ 这是**有意为之**，不是漏判：生产上 19 个 SALES 全部兼任 OPERATOR，
 *   业务上他们就是要看全量。改成"只要有 SALES 就隔离"会让这 19 个人第二天
 *   打不开客户列表。真要让隔离生效，得先在业务上把兼任拆开（台账 T7 里写了）。
 */
export function salesRowScope(caller: ScopeCaller | null | undefined): { salesUserId: string } | null {
  if (!caller?.userId) return null
  const roles = rolesOf(caller)
  if (roles.includes('EXTERNAL_SALES')) return { salesUserId: caller.userId }
  if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
    return { salesUserId: caller.userId }
  }
  return null
}

/**
 * 把行级条件并进 where —— **这是唯一正确的合并方式**。
 *
 * 用 AND 包一层，而不是 `where.salesUserId = …` 直接赋值：后者会被同名的
 * 查询参数覆盖掉（`?salesUserId=别人的id` 就是这么绕过去的），
 * 而 AND 里的那一项谁也删不掉。
 */
export function withRowScope(
  where: Record<string, unknown>,
  scope: { salesUserId: string } | null,
): Record<string, unknown> {
  if (!scope) return where
  const existing = Array.isArray(where.AND) ? where.AND as unknown[] : where.AND ? [where.AND] : []
  return { ...where, AND: [...existing, scope] }
}

/**
 * 单条记录是否在可见范围内。详情/编辑接口用 —— 列表挡住了但详情没挡的话，
 * 拿到 id 依然能逐条读走（id 在打印单、CSV 导出里到处都是）。
 */
export function isRowVisible(
  record: { salesUserId?: string | null } | null | undefined,
  scope: { salesUserId: string } | null,
): boolean {
  if (!scope) return true
  if (!record) return false
  return record.salesUserId === scope.salesUserId
}
