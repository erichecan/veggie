import { decodePermissions } from './rbac/bitmap'
import { isKnownPermission } from './rbac/catalog'

/**
 * 权限定义 & 检查
 * ============================================================================
 * 轻量 RBAC：不依赖任何 npm 包（@casl 等），用纯 TS 对象 + `can()` 函数。
 *
 * 用法：
 *   // 前端
 *   import { can, useAbility } from '@/lib/permissions'
 *   const ability = useAbility()   // 从 localStorage / session 推断角色
 *   {can(ability, 'delete', 'invoice') && <DeleteButton />}
 *
 *   // 后端
 *   if (!can({ role: user.role }, 'delete', 'invoice')) return 403
 *
 * 与 withAuth 的关系：
 *   withAuth 是"接口级"角色闸；can() 是"UI/细粒度"权限判定。
 *   两个都要做 — UI 隐藏按钮提升体验，后端拦截保证安全。
 */

/**
 * ⛔ 必须与 prisma/schema.prisma 的 `enum Role` 和 lib/types.ts 的 `UserRole` 三处一致。
 * tests/role-definitions-sync.test.ts 会比对这三处，漂了就失败。
 *
 * 2026-08-06 审计发现这里曾少了 DISPATCH / OTHER 两个：`MATRIX` 是
 * `Record<Role, …>`，查 `MATRIX['DISPATCH']` 得到 undefined，只是当时恰好
 * 没有用户是这两种角色才没炸。
 */
export type Role =
  | 'OPERATOR' | 'RESTAURANT' | 'PICKER' | 'SORTER'
  | 'DRIVER' | 'BOSS' | 'FINANCE' | 'WAREHOUSE'
  | 'SALES' | 'EXTERNAL_SALES' | 'DISPATCH' | 'OTHER'

export type Action =
  | 'read' | 'create' | 'update' | 'delete'
  | 'confirm' | 'cancel' | 'receive' | 'invoice' | 'pay'
  | 'export_gdpr' | 'delete_gdpr' | 'manage_users'
  | 'settle' | 'approve_edit'

export type Subject =
  | 'order' | 'invoice' | 'product' | 'product_template' | 'pricelist'
  | 'customer' | 'supplier' | 'purchase_order' | 'goods_receipt' | 'vendor_bill'
  | 'wave' | 'trip' | 'stock_move' | 'user' | 'uom' | 'uom_category'
  | 'statement' | 'purchase_suggestion' | 'notification'
  | 'analytics' | 'stock_take'

export interface Ability {
  role: Role
  /** 权限位图（base64url）。有它就按它判，没有则回落到 MATRIX */
  pm?: string
  /** 全部角色(多角色账号)。非空时按并集判权限,与后端 effectiveRoles 口径一致;空则回退 role。 */
  roles?: Role[]
  userId?: string
  customerId?: string | null
}

/** 取生效角色集合:roles[] 优先,空则回退单 role。与 lib/auth.ts effectiveRoles 对齐。 */
function effectiveAbilityRoles(ability: Ability): Role[] {
  if (Array.isArray(ability?.roles) && ability.roles.length > 0) return ability.roles
  return ability?.role ? [ability.role] : []
}

/**
 * 角色 → 能力矩阵。只列允许的 (action, subject) 对，其他都默认拒绝。
 * BOSS 默认允许所有操作（在 can() 里短路）。
 */
const MATRIX: Record<Role, Partial<Record<Subject, Action[]>>> = {
  BOSS: {
    // 所有 subject 的所有 action — 在 can() 里短路
  },

  OPERATOR: {
    order:               ['read', 'create', 'update', 'delete', 'confirm', 'cancel', 'approve_edit'],
    invoice:             ['read', 'create', 'update', 'delete'],
    product:             ['read', 'create', 'update', 'delete'],
    product_template:    ['read', 'create', 'update', 'delete'],
    pricelist:           ['read', 'create', 'update', 'delete'],
    customer:            ['read', 'create', 'update', 'delete', 'export_gdpr', 'delete_gdpr'],
    supplier:            ['read', 'create', 'update', 'delete'],
    purchase_order:      ['read', 'create', 'update', 'confirm', 'cancel'],
    goods_receipt:       ['read', 'create'],
    vendor_bill:         ['read', 'create'],
    wave:                ['read', 'create', 'update', 'delete'],
    trip:                ['read', 'create', 'update', 'delete'],
    stock_move:          ['read', 'create'],
    user:                ['read', 'create', 'update', 'manage_users'],
    uom:                 ['read', 'create', 'update'],
    uom_category:        ['read', 'create', 'update'],
    purchase_suggestion: ['read', 'create', 'update'],
    notification:        ['read'],
    statement:           ['read'],
    analytics:           ['read'],
    stock_take:          ['read', 'create', 'update'],
  },

  FINANCE: {
    invoice:          ['read', 'create', 'update', 'pay', 'cancel'],
    vendor_bill:      ['read', 'create', 'update', 'pay'],
    customer:         ['read'],
    supplier:         ['read'],
    order:            ['read'],
    purchase_order:   ['read'],
    statement:        ['read', 'create', 'update', 'delete'],
    trip:             ['read', 'settle'],
    notification:     ['read'],
    analytics:        ['read'],
  },

  WAREHOUSE: {
    product:             ['read', 'update'],
    stock_move:          ['read', 'create'],
    goods_receipt:       ['read', 'create'],
    purchase_order:      ['read', 'receive'],
    wave:                ['read'],
    trip:                ['read'],
    purchase_suggestion: ['read'],
    notification:        ['read'],
    stock_take:          ['read', 'create', 'update'],
  },

  RESTAURANT: {
    order:            ['read', 'create'],     // 只看自己的，由后端过滤
    product:          ['read'],
    invoice:          ['read'],                // 只看自己的
    customer:         ['read', 'export_gdpr', 'delete_gdpr'],  // 自己的数据
  },

  PICKER: {},

  SORTER: {
    wave:   ['read', 'update'],
    trip:   ['read', 'update'],
  },

  DRIVER: {
    trip:             ['read', 'update', 'settle'],
    order:            ['read'],
    notification:     ['read'],
  },

  /** 正式销售（公司内部员工） */
  SALES: {
    order:            ['read', 'create', 'update'],
    customer:         ['read', 'create', 'update'],
    product:          ['read'],
    invoice:          ['read'],
    pricelist:        ['read'],
    notification:     ['read'],
  },

  /**
   * 外部合作销售 —— 公司外部的人，按更窄的边界给权限。
   *
   * 与正式 SALES 的差别（2026-08-06 用户要求把 sales 分成两类）：
   *   - 不给 `invoice`：发票是财务信息，含账期与欠款
   *   - 不给 `pricelist`：整套价格体系是商业机密，外部只需看到具体商品的报价
   *   - `customer` 不给 update：改客户资料（信用额度、税号）不该由外部人做
   *
   * ⛔ 还必须配合**行级隔离**才有意义：外部销售只能看到自己名下的客户与其订单。
   * 光靠这张表只能挡住「能不能做这个动作」，挡不住「能看到谁的数据」。
   */
  EXTERNAL_SALES: {
    order:            ['read', 'create'],
    customer:         ['read', 'create'],
    product:          ['read'],
    notification:     ['read'],
  },

  /** 调度：排波次、派车、改派司机。不碰钱、不碰商品定价。 */
  DISPATCH: {
    wave:             ['read', 'create', 'update'],
    trip:             ['read', 'create', 'update'],
    order:            ['read', 'update'],
    customer:         ['read'],
    notification:     ['read'],
  },

  /**
   * 未分类角色。**刻意给空权限** —— schema 里有这个枚举值，
   * 与其让它落进 `MATRIX[role] === undefined` 的未定义状态，不如显式声明为"什么都不能做"。
   * 真要给某人权限，应该分配一个明确的角色，而不是用 OTHER。
   */
  OTHER: {},
}

/**
 * (action, subject) → 权限点 id。
 *
 * 20260807：判定真相搬到了 `lib/rbac/catalog.ts` 的权限点上，`MATRIX` 退居兼容层。
 * 这张表把旧的两段式写法翻译成权限点，这样 `can()` 的对外签名一个字没变，
 * 调用方不用改。翻不出来的组合回落到 MATRIX —— 不是所有旧组合都有对应权限点。
 */
const SUBJECT_MODULE: Partial<Record<Subject, string>> = {
  order: 'sales.order',
  invoice: 'finance.invoice',
  product: 'master.product',
  product_template: 'master.product_template',
  pricelist: 'master.pricelist',
  customer: 'master.customer',
  supplier: 'master.supplier',
  purchase_order: 'purchase.order',
  goods_receipt: 'stock.receipt',
  vendor_bill: 'finance.vendor_bill',
  wave: 'dispatch.wave',
  trip: 'dispatch.trip',
  stock_move: 'stock.move',
  user: 'system.user',
  uom: 'master.uom',
  uom_category: 'master.uom_category',
  statement: 'finance.statement',
  purchase_suggestion: 'purchase.suggestion',
  stock_take: 'stock.take',
  analytics: 'analytics.sales',
}

/** 少数动作在新目录里换了名字 */
const ACTION_ALIAS: Partial<Record<Action, string>> = {
  manage_users: 'manage',
  settle: 'confirm',
  approve_edit: 'update',
  receive: 'receive',
  pay: 'pay',
}

function permissionIdFor(action: Action, subject: Subject): string | null {
  const module = SUBJECT_MODULE[subject]
  if (!module) return null
  return `${module}.${ACTION_ALIAS[action] ?? action}`
}

/**
 * 检查当前能力是否允许执行 (action, subject)。
 *
 * 优先按权限位图判（登录时算好塞进 session 的 `pm`）。位图缺失时 —— 旧会话、
 * 或服务端渲染阶段还没读到 localStorage —— 回落到 MATRIX，行为与改造前一致。
 *
 * ⚠️ 这是**前端显隐**用的，不是安全边界。真正的拦截在 middleware 与路由层，
 * 改浏览器里的 pm 只能让自己多看见几个按钮，点下去照样 403。
 */
export function can(ability: Ability, action: Action, subject: Subject): boolean {
  const roles = effectiveAbilityRoles(ability)

  if (ability.pm) {
    const id = permissionIdFor(action, subject)
    if (id && isKnownPermission(id)) return decodePermissions(ability.pm).has(id)
  }

  if (roles.length === 0) return false
  if (roles.includes('BOSS')) return true
  return roles.some((r) => (MATRIX[r]?.[subject] ?? []).includes(action))
}

/** 直接按权限点判 —— 新代码用这个，别再走 (action, subject) 两段式 */
export function hasPermission(ability: Ability, permissionId: string): boolean {
  if (ability.pm) return decodePermissions(ability.pm).has(permissionId)
  return false
}

/**
 * React hook：从 sessionStorage 读当前用户角色生成 Ability。
 * 组件内直接调用，SSR 阶段返回 null ability 避免 hydration mismatch。
 */
import { useEffect, useState } from 'react'

export function useAbility(): Ability {
  const [ability, setAbility] = useState<Ability>({ role: 'RESTAURANT' })  // 默认最小权限
  useEffect(() => {
    try {
      // lib/session.ts 用 localStorage 存（多 Tab 共享）
      const raw = (typeof window !== 'undefined')
        ? localStorage.getItem('veggie_user')
        : null
      if (raw) {
        const u = JSON.parse(raw)
        const roles = Array.isArray(u.roles) && u.roles.length > 0
          ? (u.roles as Role[])
          : [u.role as Role]
        setAbility({
          role: u.role as Role,
          roles,
          userId: u.userId,
          customerId: u.customerId,
          pm: typeof u.pm === 'string' ? u.pm : undefined,
        })
      }
    } catch { /* ignore */ }
  }, [])
  return ability
}
