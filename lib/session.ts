/**
 * lib/session.ts
 * 读取登录后存储在 localStorage 的 JWT 用户信息
 * 替代原来的 StoreAPI.getRole() / StoreAPI.setRole()
 */

export interface UserSession {
  userId: string
  email: string
  role: string  // 兼容字段(单角色);权限判定优先看 roles[]
  /** 全部角色(多角色账号),login 接口已返回。前端 can()/useAbility 按此并集判权限。 */
  roles?: string[]
  /** 权限位图（base64url），与 JWT 的 pm 同源。仅用于前端显隐 */
  pm?: string
  /** 数据范围 ALL | TEAM | OWN */
  ds?: string
  /** 必须先改密码才能用系统。前端据此跳改密页；真正的拦截在 withAuth */
  mustChangePassword?: boolean
  name: string
  customerId?: string | null
}

/** 从 localStorage 读取登录用户信息（纯同步，无网络请求） */
export function getSession(): UserSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('veggie_user')
    if (!raw) return null
    return JSON.parse(raw) as UserSession
  } catch {
    return null
  }
}

/**
 * 退出登录。
 * 登录 cookie 是服务端下发的 HttpOnly —— JS 删不掉，必须调一次
 * /api/auth/logout 让服务端清；本地状态同时清掉。接口失败不阻塞退出
 * （大不了 cookie 到期自然失效），所以是 fire-and-forget。
 */
export function logout(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem('veggie_user')
  localStorage.removeItem('veggie_token')
  // 历史遗留的 JS 版同名 cookie 也顺手清掉
  document.cookie = 'veggie_token=; max-age=0; path=/'
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
}

/**
 * 把 UserSession 转成各 Layout 使用的 { role, id, name } 格式
 * - RESTAURANT 角色用 customerId 作为 id（对应 restaurantId）
 * - 其他角色用 userId
 */
import type { RoleSession } from './types'

export function toRoleSession(user: UserSession): RoleSession {
  return {
    role: user.role.toLowerCase() as RoleSession['role'],
    id: user.role === 'RESTAURANT' ? (user.customerId ?? user.userId) : user.userId,
    name: user.name,
  }
}
