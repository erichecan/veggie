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

const AUTH_COOKIE_MAX_AGE = 7 * 24 * 3600

/**
 * 写登录 cookie —— **写 cookie 只走这一个函数**。
 * 原先 `enter/page.tsx` 与这里各写了一份同样的字符串，加 `Secure` 时差点只改了一处。
 *
 * `Secure` 按当前协议决定，不是无条件加：无条件加的话，HTTP 下浏览器**直接丢弃**
 * 这个 cookie，表现是"登录成功但立刻又被踢回登录页"。本地开发和
 * TLS 生效前的过渡窗口都还是 HTTP，所以按协议判定。
 * （彻底的做法是服务端下发 HttpOnly cookie，见台账 W0-3，那是另一件事。）
 */
export function writeAuthCookie(token: string): void {
  if (typeof document === 'undefined') return
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `veggie_token=${token}; path=/; max-age=${AUTH_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
}

/** 登录后写入 session（enter/page.tsx 已经做了，这里保留供外部调用） */
export function setSession(user: UserSession, token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('veggie_user', JSON.stringify(user))
  localStorage.setItem('veggie_token', token)
  writeAuthCookie(token)
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
