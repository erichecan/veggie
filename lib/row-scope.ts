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
  /** 数据范围（token 的 ds 字段）。有它就按它判，没有则回退下面的角色硬编码 */
  ds?: string | null
}

/** 行级范围。`null` 表示不隔离（看全部） */
export type RowScope =
  | { kind: 'own'; userId: string }
  | { kind: 'team'; userId: string }
  | null

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
export function salesRowScope(caller: ScopeCaller | null | undefined): RowScope {
  if (!caller?.userId) return null

  // 新 token：范围由角色配置决定，不再按角色名字硬编码。
  // 多角色账号的范围在登录时已经取过最宽（见 lib/rbac/resolve.ts），这里直接用。
  if (caller.ds === 'ALL') return null
  if (caller.ds === 'OWN') return { kind: 'own', userId: caller.userId }
  if (caller.ds === 'TEAM') return { kind: 'team', userId: caller.userId }

  // 旧 token（没有 ds）：回退到改造前的硬编码判断，行为一个字不变。
  // 可在全部旧 token 过期后删掉（2026-08-14）。
  const roles = rolesOf(caller)
  if (roles.includes('EXTERNAL_SALES')) return { kind: 'own', userId: caller.userId }
  if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
    return { kind: 'own', userId: caller.userId }
  }
  return null
}

/**
 * 把范围翻成 Prisma where 片段。
 *
 * TEAM 用**关系过滤**而不是先查一遍下属 id 再 `in` —— 后者要多打一次库，
 * 而且下属列表变化时会有时间窗。关系过滤由数据库一次算完。
 */
export function scopeCondition(scope: RowScope): Record<string, unknown> | null {
  if (!scope) return null
  if (scope.kind === 'own') return { salesUserId: scope.userId }
  return {
    OR: [
      { salesUserId: scope.userId },
      { salesUser: { managerId: scope.userId } },
    ],
  }
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
  scope: RowScope,
): Record<string, unknown> {
  const cond = scopeCondition(scope)
  if (!cond) return where
  const existing = Array.isArray(where.AND) ? where.AND as unknown[] : where.AND ? [where.AND] : []
  return { ...where, AND: [...existing, cond] }
}

// ─── 司机侧（Trip.driverId）────────────────────────────────────────────────────

/** 兼任这些角色之一，就是要看全量行程的人（调度台、老板、财务交账都得看别人的） */
const TRIP_UNSCOPED_ROLES = ['OPERATOR', 'BOSS', 'FINANCE', 'DISPATCH'] as const

/**
 * 按司机归属隔离（`Trip.driverId`）。返回 null 表示不隔离。
 *
 * ⛔ 为什么必须有这一层：`GET /api/trips` 的 `driverId` 是**查询参数**，
 * 司机端自己传 `?driverId=我的id` 来过滤。但那是前端的自觉 ——
 * 换个 id 就能看别人的行程（客户地址、金额、收款一并带出），
 * 干脆不传参数则拿到全公司的行程。与 20260802 `/api/customers` 那次同类：
 * **前端过滤不是隔离**。
 *
 * 与 salesRowScope 的差别：销售那边「兼任 OPERATOR 就不隔离」是被生产现状
 * 逼出来的妥协（19 个 SALES 全兼任）。司机这边没有这个包袱 ——
 * 只挂 DRIVER 的账号一律只看自己的，兼任管理岗的才放行。
 */
export function driverRowScope(caller: ScopeCaller | null | undefined): RowScope {
  if (!caller?.userId) return null
  const roles = rolesOf(caller)
  if (!roles.includes('DRIVER')) return null
  if (roles.some((r) => (TRIP_UNSCOPED_ROLES as readonly string[]).includes(r))) return null
  return { kind: 'own', userId: caller.userId }
}

/**
 * 把司机范围并进 where。同样用 AND 包一层 ——
 * 直接写 `where.driverId = …` 会被查询参数里的同名字段覆盖，
 * 那正是 `buildOrdersWhere` 20260806 被 `?salesUserId=别人的id` 绕过去的原因。
 */
export function withDriverScope(
  where: Record<string, unknown>,
  scope: RowScope,
): Record<string, unknown> {
  if (!scope) return where
  const existing = Array.isArray(where.AND) ? where.AND as unknown[] : where.AND ? [where.AND] : []
  return { ...where, AND: [...existing, { driverId: scope.userId }] }
}

/**
 * 单条记录是否在可见范围内。详情/编辑接口用 —— 列表挡住了但详情没挡的话，
 * 拿到 id 依然能逐条读走（id 在打印单、CSV 导出里到处都是）。
 */
export function isRowVisible(
  record: { salesUserId?: string | null; salesUser?: { managerId?: string | null } | null } | null | undefined,
  scope: RowScope,
): boolean {
  if (!scope) return true
  if (!record) return false
  if (record.salesUserId === scope.userId) return true
  if (scope.kind === 'own') return false

  // TEAM：还要看这单的业务员是不是我的下属。
  // ⛔ 调用方必须把 `salesUser: { select: { managerId: true } }` 一起 select 出来，
  //    否则这里只能保守拒绝 —— 宁可少给，也不能因为字段没取就放行别人的数据。
  return record.salesUser?.managerId === scope.userId
}
