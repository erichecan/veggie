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

export type Role =
  | 'OPERATOR' | 'RESTAURANT' | 'PICKER' | 'SORTER'
  | 'DRIVER' | 'BOSS' | 'FINANCE' | 'WAREHOUSE' | 'SALES'

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

export interface Ability {
  role: Role
  userId?: string
  customerId?: string | null
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

  SALES: {
    order:            ['read', 'create', 'update'],
    customer:         ['read', 'create', 'update'],
    product:          ['read'],
    invoice:          ['read'],
    pricelist:        ['read'],
    notification:     ['read'],
  },
}

/**
 * 检查当前能力是否允许执行 (action, subject)。
 */
export function can(ability: Ability, action: Action, subject: Subject): boolean {
  if (!ability?.role) return false
  if (ability.role === 'BOSS') return true
  const allowed = MATRIX[ability.role]?.[subject] ?? []
  return allowed.includes(action)
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
        setAbility({ role: u.role as Role, userId: u.userId, customerId: u.customerId })
      }
    } catch { /* ignore */ }
  }, [])
  return ability
}
