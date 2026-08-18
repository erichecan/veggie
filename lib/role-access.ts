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
 * 还能 `POST /api/pricelists` 真的写进去。根因是 235 个 handler 里有 152 个
 * 没有角色闸。**逐个补要改 152 处，漏一处就还是漏**；而收窄型角色的边界
 * 本来就该是「白名单之外全拒」，一处判定覆盖全部现有和将来新增的路由。
 *
 * 边界怎么定的：**从各角色实际能进的页面反推**（页面层白名单在 6 个 layout 里），
 * 逐页扫出它调用的接口，而不是拍脑袋列。列表里每一条都对应真实调用点。
 *
 * 见 docs/20260806-rbac-audit-and-tasks.md
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * 一条可达规则。
 *
 * `pattern` 的段语法（不是普通前缀匹配 —— 前缀匹配正是 20260802 泄露客户名册的成因，
 * 加一条 `/api/customers` 会连带放行整棵子树）：
 *   - `/api/trips`              精确匹配这一条
 *   - `/api/trips/*`            `*` 恰好匹配一段（`/api/trips/abc`，但不含 `/api/trips/abc/x`）
 *   - `/api/customer-portal/**` `**` 匹配任意深度（含零段，即本身）
 *
 * `methods` 省略 = 该 pattern 下所有方法。
 */
export interface ApiScope {
  pattern: string
  methods?: readonly HttpMethod[]
}

const READ: readonly HttpMethod[] = ['GET']

/**
 * 某实体的导出入口。**必须与该实体的列表条目成对出现** —— 只给列表不给导出的话，
 * 这个角色的旧 token 会「列表看得见、点导出 403」，且没有任何报错。
 * tests/export-access-parity.test.ts 守这条不变量。
 */
const exportOf = (entity: string): ApiScope => ({ pattern: `/api/export/${entity}`, methods: READ })

/**
 * 每个收窄型角色都需要的公共部分：登录/改密、健康检查、自己的通知。
 * 少了任何一条，对应角色连登录后的导航栏都会报错。
 */
const COMMON: readonly ApiScope[] = [
  { pattern: '/api/auth/**' },
  { pattern: '/api/health' },
  { pattern: '/api/notifications/**' },
  { pattern: '/api/tile' },          // 地图瓦片代理，本身就是公开路由
]

/**
 * 角色 → 可达 API。**没有列在这里的角色不受这一层收窄**（见 UNSCOPED_ROLES）。
 *
 * ⛔ 往任何一条里加东西之前先问：这个角色的人拿到这个接口的数据，
 * 会不会看到不属于他职责范围的客户 / 成本 / 财务 / 配置？
 */
export const ROLE_API_SCOPE: Record<string, readonly ApiScope[]> = {
  /**
   * 餐馆客户：只能通过订购页面看**属于自己的价格**的商品，别的一律不可见，
   * 也不能登录运营后台（2026-08-06 用户明确定的边界）。
   *
   * `/api/customer-portal/*` 三个路由都已按 customerId 做行级隔离，
   * 且 products 只回 customerPrice，不回 standardPrice / listPrice / commissionPrice。
   */
  RESTAURANT: [
    ...COMMON,
    { pattern: '/api/customer-portal/**' },
  ],

  /**
   * 司机（生产 21 人，唯一有真实用户的收窄角色）。
   * 页面只有 `/classic/driver/*`，实际调用点：
   *   GET  /api/trips?driverId=…      行程列表
   *   GET  /api/trips/[id]            行程详情
   *   PUT  /api/trips/[id]            签收/退货/完成站点（整包覆盖 restaurants JSON）
   *   GET/POST /api/trips/[id]/settlement   交账提交
   *   GET  /api/customers/coordinates 地图打点
   * ⛔ 不给 `/api/trips` 的 POST/DELETE —— 建行程和删行程是调度的事。
   * ⛔ 不给 `/api/orders` —— 司机看订单是通过行程详情带出来的，不需要全量订单接口。
   */
  DRIVER: [
    ...COMMON,
    { pattern: '/api/trips', methods: READ },
    { pattern: '/api/trips/*', methods: ['GET', 'PUT'] },
    { pattern: '/api/trips/*/settlement', methods: ['GET', 'POST'] },
    // C8：司机收车时提交当日回传。行级隔离在 handler 里（driverRowScope），
    // 司机改一个 driverId 也只能报自己的
    { pattern: '/api/driver-reports/daily', methods: ['GET', 'POST'] },
    // C10 对账汇总。给司机是**为了让两条路径一致**，不是顺手放开：司机的位图里本来
    // 就有 `finance.settlement.read`（C8 那张卡片要用），所以**新 token 的司机本就
    // 够得着**这个接口；这里不补的话，同一个人拿新 token 能调、拿旧 token 403 ——
    // 一个只在重登前后表现不同的接口，比一直开着或一直关着都难查。
    // 安全性由 handler 的 driverRowScope 保证：司机传别人的 driverId 也只拿到自己的
    // （端到端实测在 scripts/audit/driver-reconciliation-test.ts 的 ⑦）
    { pattern: '/api/driver-reports/summary', methods: READ },
    { pattern: '/api/customers/coordinates', methods: READ },
  ],

  /**
   * 分拣：页面 `/classic/sorter/*`，只做波次分拣状态推进。
   * 波次读全部子路由（拣货单、缺货表），写只到波次本身。
   */
  SORTER: [
    ...COMMON,
    { pattern: '/api/waves/**', methods: READ },
    { pattern: '/api/waves/*', methods: ['PUT'] },
    { pattern: '/api/orders', methods: READ },
  ],

  /**
   * 仓库：页面 `/classic/warehouse/*`（库存、盘点、临期、收货）。
   * 与 `lib/permissions.ts` 的 WAREHOUSE 矩阵一致：商品可读可改库存相关，
   * 不碰客户、订单价格、发票与分析。
   */
  WAREHOUSE: [
    ...COMMON,
    { pattern: '/api/products/**', methods: READ },
    { pattern: '/api/product-templates/**', methods: READ },
    exportOf('product-templates'),
    { pattern: '/api/product-categories/**', methods: READ },
    { pattern: '/api/lots/**', methods: READ },
    { pattern: '/api/lots', methods: ['POST'] },
    { pattern: '/api/zones/**', methods: READ },
    { pattern: '/api/uoms/**', methods: READ },
    { pattern: '/api/uom-categories/**', methods: READ },
    { pattern: '/api/orders', methods: READ },
    { pattern: '/api/orders/*', methods: READ },
    { pattern: '/api/purchases', methods: ['GET', 'POST'] },
    { pattern: '/api/purchases/*', methods: READ },
    { pattern: '/api/purchase-orders/**', methods: READ },
    { pattern: '/api/goods-receipts/**', methods: ['GET', 'POST'] },
    { pattern: '/api/stock-moves/**', methods: ['GET', 'POST'] },
    { pattern: '/api/stock-takes', methods: ['GET', 'POST'] },
    { pattern: '/api/stock-takes/*', methods: ['GET', 'PATCH'] },
    { pattern: '/api/scrap/**', methods: ['GET', 'POST'] },
  ],

  /**
   * 财务：页面 `/classic/finance/*` 与 `/classic/accounting/*`。
   * 钱的那一摊全给（发票、对账单、收付款、供应商账单、退款单），
   * 主数据只读，**不给任何写**（改客户信用额度、改商品价格不是财务的活）。
   */
  FINANCE: [
    ...COMMON,
    { pattern: '/api/invoices/**' },
    { pattern: '/api/statements/**' },
    { pattern: '/api/payments/**' },
    { pattern: '/api/vendor-bills/**' },
    { pattern: '/api/credit-notes/**' },
    { pattern: '/api/finance/**' },
    { pattern: '/api/accounts/**' },
    { pattern: '/api/reports/**', methods: READ },
    { pattern: '/api/analytics/**', methods: READ },
    { pattern: '/api/customers/**', methods: READ },
    { pattern: '/api/orders/**', methods: READ },
    // 把单据邮件发给客户。财务对订单其余部分仍是只读 —— 这条精确到 send-email，
    // 不是给 /api/orders/** 放开 POST。新体系里 finance 本来就有 sales.order.print，
    // 这里补齐旧 token 路径，免得没重新登录的人点发送就 403。
    { pattern: '/api/orders/*/send-email', methods: ['POST'] },
    { pattern: '/api/suppliers/**', methods: READ },
    { pattern: '/api/purchase-orders/**', methods: READ },
    { pattern: '/api/trips', methods: READ },
    { pattern: '/api/trips/*', methods: READ },
    { pattern: '/api/trips/*/settlement', methods: ['GET', 'PUT'] },   // 确认/退回交账
    { pattern: '/api/driver-reports/daily', methods: ['GET', 'PUT'] },  // C8 查看 / C9 确认当日货款
    // C10 对账状态统计。⛔ 段级匹配是精确的，`/daily` 那条**不覆盖** `/summary` ——
    // 漏了这条，旧 token（部署后未重登）的财务打开对账页就是 403，
    // 而页面拿不到数据会退化成「一条待办都没有」，比报错更危险（D1 栽过一次）
    { pattern: '/api/driver-reports/summary', methods: READ },
    { pattern: '/api/driver-slots', methods: READ },
    { pattern: '/api/users', methods: READ },
    // 打印状态查询：这两个角色本来就能调 /api/print/** 打单，能打印却看不到
    // 「打过没有」会导致重复打印。旧 token（部署后未重新登录）走的是这张白名单，
    // 漏了它就会 403 —— 而前端拿不到状态时退回"全都没打过"，恰好造成全量重打。
    { pattern: '/api/waves/print-status', methods: READ },
    { pattern: '/api/print/**', methods: READ },
  ],

  /**
   * 调度：排波次、派车、改派司机。与 permissions.ts 的 DISPATCH 一致 ——
   * 不碰钱、不碰商品定价、不碰主数据写。
   */
  DISPATCH: [
    ...COMMON,
    { pattern: '/api/waves/**', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { pattern: '/api/trips/**', methods: ['GET', 'POST', 'PUT', 'PATCH'] },
    { pattern: '/api/orders', methods: READ },
    { pattern: '/api/orders/*', methods: READ },
    { pattern: '/api/orders/*/batch', methods: ['PUT'] },
    { pattern: '/api/orders/*/mark-printed', methods: ['POST'] },
    { pattern: '/api/orders/dispatch-print-data', methods: READ },
    { pattern: '/api/dispatch/**', methods: READ },
    { pattern: '/api/daily-sales/**', methods: READ },
    { pattern: '/api/driver-slots', methods: READ },
    { pattern: '/api/customers', methods: READ },
    { pattern: '/api/customers/coordinates', methods: READ },
    { pattern: '/api/products', methods: READ },
    { pattern: '/api/batch-analysis', methods: READ },
    { pattern: '/api/geocode', methods: READ },
    { pattern: '/api/distance-matrix', methods: READ },
    { pattern: '/api/print/**', methods: READ },
  ],

  /**
   * 正式销售（公司内部员工）：下单、报价、看客户与商品。
   * 不给 DELETE（删订单/删客户是运营的事），不给采购与库存，不给分析中心。
   */
  SALES: [
    ...COMMON,
    { pattern: '/api/orders/**', methods: ['GET', 'POST', 'PUT', 'PATCH'] },
    { pattern: '/api/customers/**', methods: ['GET', 'POST', 'PUT'] },
    // 联系人（多邮箱）可以改删 —— 删客户不给销售，但删一个写错的联系人邮箱是日常。
    // ⛔ 必须精确写到 contacts 子树：直接给 /api/customers/** 放 DELETE 会连带
    //    放行删客户本身，那就是 20260802 泄露的同一种成因（宽 pattern 顺带放行整棵子树）。
    { pattern: '/api/customers/*/contacts/**', methods: ['PATCH', 'DELETE'] },
    { pattern: '/api/products/**', methods: READ },
    { pattern: '/api/product-templates/**', methods: READ },
    exportOf('product-templates'),
    { pattern: '/api/product-categories/**', methods: READ },
    { pattern: '/api/pricelists/**', methods: READ },
    { pattern: '/api/invoices/**', methods: READ },
    { pattern: '/api/uoms/**', methods: READ },
    { pattern: '/api/users', methods: READ },          // 列表页按业务员筛选
    { pattern: '/api/print/**', methods: READ },
    // 打印状态查询：这两个角色本来就能调 /api/print/** 打单，能打印却看不到
    // 「打过没有」会导致重复打印。旧 token（部署后未重新登录）走的是这张白名单，
    // 漏了它就会 403 —— 而前端拿不到状态时退回"全都没打过"，恰好造成全量重打。
    { pattern: '/api/waves/print-status', methods: READ },
    { pattern: '/api/waves', methods: READ },          // 销售单列表显示波次/司机
    { pattern: '/api/driver-slots', methods: READ },
  ],

  /**
   * 外部合作销售 —— 公司外部的人，比正式 SALES 再窄一圈
   * （2026-08-06 用户要求把 sales 分成两类）：
   *   - 不给 invoice：发票是财务信息，含账期与欠款
   *   - 不给 pricelist：整套价格体系是商业机密，只该看到具体商品的报价
   *   - customer 不给 PUT：改信用额度、税号不该由外部人做
   *   - 不给 /api/users：公司花名册没必要给外部
   *
   * ⛔ 这一层只挡「能不能碰这个接口」。**还必须配合行级隔离**（只看自己名下客户），
   * 否则他仍然能看到全部客户 —— 那部分是 T7，见 lib/row-scope.ts。
   */
  EXTERNAL_SALES: [
    ...COMMON,
    { pattern: '/api/orders/**', methods: ['GET', 'POST', 'PUT', 'PATCH'] },
    { pattern: '/api/customers/**', methods: ['GET', 'POST'] },
    { pattern: '/api/products/**', methods: READ },
    { pattern: '/api/product-templates/**', methods: READ },
    exportOf('product-templates'),
    { pattern: '/api/product-categories/**', methods: READ },
    { pattern: '/api/uoms/**', methods: READ },
    { pattern: '/api/print/**', methods: READ },
  ],

  /**
   * 拣货：schema 里有这个角色，但**没有任何页面接纳它**
   * （`/classic/sorter` 的 layout 只放 SORTER / OPERATOR），permissions.ts 里也是空矩阵。
   * 所以这里只给公共部分。真要让拣货员干活，得先给他一个页面 —— 那时再连同这里一起改。
   */
  PICKER: [...COMMON],

  /**
   * 未分类角色：**刻意只给公共部分**。真要给某人权限，
   * 应该分配一个明确的角色，而不是用 OTHER 兜着。
   */
  OTHER: [...COMMON],
}

/**
 * 外部身份：即使这个账号同时挂了内部角色，也按外部处理。
 * 餐厅客户兼任 OPERATOR 这种组合只可能是配错了，宁可挡住。
 */
const STICKY_ROLES = ['RESTAURANT'] as const

/** 后台角色本身，不在这一层收窄（他们的边界靠 allowedRoles 与 can() 管） */
const UNSCOPED_ROLES = ['OPERATOR', 'BOSS'] as const

/**
 * 角色 → 允许访问的页面前缀（去掉 locale 前缀后的路径）。
 * 其余一律踢回自己的主页，而不是让他们看到别人后台的空壳页面。
 */
export const ROLE_PAGE_SCOPE: Record<string, readonly string[]> = {
  RESTAURANT: ['/customer-portal', '/enter'],
  DRIVER: ['/classic/driver', '/enter'],
  SORTER: ['/classic/sorter', '/enter'],
  WAREHOUSE: ['/classic/warehouse', '/enter'],
  FINANCE: ['/classic/finance', '/classic/accounting', '/classic/print', '/enter'],
  DISPATCH: ['/classic/operator/dispatch-console', '/classic/print', '/enter'],
  SALES: ['/classic/operator', '/classic/print', '/enter'],
  EXTERNAL_SALES: ['/classic/operator', '/enter'],
  PICKER: ['/enter'],
  OTHER: ['/enter'],
}

/** 该角色被拦下后该去哪 */
export const ROLE_HOME: Record<string, string> = {
  RESTAURANT: '/customer-portal',
  DRIVER: '/classic/driver',
  SORTER: '/classic/sorter',
  WAREHOUSE: '/classic/warehouse',
  FINANCE: '/classic/finance',
  DISPATCH: '/classic/operator/dispatch-console',
  SALES: '/classic/operator',
  EXTERNAL_SALES: '/classic/operator',
}

/**
 * 段级匹配。`*` 一段、`**` 任意深度（含零段）。
 * ⛔ 不做普通前缀匹配 —— `/api/auth` 前缀匹配会把 `/api/authorize-everything`
 * 一起放行，`/api/customers` 会把整棵子树放行（20260802 泄露就是这么来的）。
 */
export function matchesPattern(pattern: string, pathname: string): boolean {
  const pat = pattern.split('/').filter(Boolean)
  const path = pathname.split('/').filter(Boolean)
  let i = 0
  for (; i < pat.length; i++) {
    if (pat[i] === '**') return true          // 只可能出现在末尾
    if (i >= path.length) return false
    if (pat[i] === '*') continue
    if (pat[i] !== path[i]) return false
  }
  return i === path.length
}

/**
 * 取这组角色的可达规则。
 *   - 含外部身份（RESTAURANT）→ 只按外部那一份，兼任的内部角色一律不算
 *   - 含 OPERATOR / BOSS       → null（不受这一层收窄）
 *   - 其余                     → 各收窄角色规则的**并集**（一人多岗时能力叠加）
 * 返回 null 表示不收窄。
 */
export function apiScopeFor(roles: string[]): readonly ApiScope[] | null {
  const sticky = roles.find(r => (STICKY_ROLES as readonly string[]).includes(r))
  if (sticky) return ROLE_API_SCOPE[sticky]
  if (roles.some(r => (UNSCOPED_ROLES as readonly string[]).includes(r))) return null
  const scoped = roles.filter(r => r in ROLE_API_SCOPE)
  if (scoped.length === 0) return null
  return scoped.flatMap(r => ROLE_API_SCOPE[r])
}

/** 页面层同理 */
export function pageScopeFor(roles: string[]): readonly string[] | null {
  const sticky = roles.find(r => (STICKY_ROLES as readonly string[]).includes(r))
  if (sticky) return ROLE_PAGE_SCOPE[sticky]
  if (roles.some(r => (UNSCOPED_ROLES as readonly string[]).includes(r))) return null
  const scoped = roles.filter(r => r in ROLE_PAGE_SCOPE)
  if (scoped.length === 0) return null
  return scoped.flatMap(r => ROLE_PAGE_SCOPE[r])
}

/** 这组角色能否用该方法访问这个 API 路径 */
export function canRolesAccessApi(roles: string[], pathname: string, method: string): boolean {
  const scope = apiScopeFor(roles)
  if (!scope) return true
  const m = method.toUpperCase() as HttpMethod
  return scope.some(s =>
    matchesPattern(s.pattern, pathname) && (!s.methods || s.methods.includes(m)),
  )
}

/** 这组角色能否访问这个页面（已去掉 locale 前缀） */
export function canRolesAccessPage(roles: string[], barePath: string): boolean {
  const scope = pageScopeFor(roles)
  if (!scope) return true
  if (barePath === '/') return true
  return scope.some(p => barePath === p || barePath.startsWith(p + '/'))
}

/** 被拦下后的落点 */
export function homeFor(roles: string[]): string {
  const sticky = roles.find(r => (STICKY_ROLES as readonly string[]).includes(r))
  if (sticky) return ROLE_HOME[sticky] ?? '/enter'
  for (const r of roles) if (ROLE_HOME[r]) return ROLE_HOME[r]
  return '/enter'
}
