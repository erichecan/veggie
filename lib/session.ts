/**
 * lib/session.ts
 * 读取登录后存储在 localStorage 的 JWT 用户信息
 * 替代原来的 StoreAPI.getRole() / StoreAPI.setRole()
 */

export interface UserSession {
  userId: string
  email: string
  role: string  // 'OPERATOR' | 'RESTAURANT' | 'PICKER' | 'SORTER' | 'DRIVER' | 'BOSS' | 'FINANCE' | 'WAREHOUSE'
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

/** 登录后写入 session（enter/page.tsx 已经做了，这里保留供外部调用） */
export function setSession(user: UserSession, token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('veggie_user', JSON.stringify(user))
  localStorage.setItem('veggie_token', token)
  document.cookie = `veggie_token=${token}; path=/; max-age=${7 * 24 * 3600}; SameSite=Lax`
}

/** 退出登录 */
export function logout(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem('veggie_user')
  localStorage.removeItem('veggie_token')
  document.cookie = 'veggie_token=; max-age=0; path=/'
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
