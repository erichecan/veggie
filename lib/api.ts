/**
 * lib/api.ts
 * 统一 API 客户端 —— 自动携带 JWT token，统一错误处理
 * ============================================================================
 * 401 响应自动清除 token 并跳转到登录页
 * 409 特殊业务错误（库存不足/状态冲突）保留后端 message 显示给用户
 * 429 限流返回 "请求过于频繁"
 * 5xx 只显示通用文案，不暴露 stack trace
 * 网络失败统一提示 "连接不上服务器"
 */

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('veggie_token')
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

export class ApiError extends Error {
  status: number
  code?: string          // 业务错误码（如 INSUFFICIENT_STOCK）
  rawMessage?: string    // 后端原始 message（用于调试）
  details?: Record<string, unknown> // 后端错误体里除 error/message 外的其余字段（如 waveId）
  constructor(message: string, status: number, code?: string, rawMessage?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.rawMessage = rawMessage
    this.details = details
  }
}

/**
 * classic 应用走 /(zh 无前缀) 和 /en 两套路由（见 i18n/routing.ts），
 * 这里是纯客户端 fetch 封装，没有 React 上下文，只能从当前 URL 路径判断语言。
 */
function isEnLocale(): boolean {
  if (typeof window === 'undefined') return false
  const p = window.location.pathname
  return p === '/en' || p.startsWith('/en/')
}

/**
 * 把后端错误码翻译成用户友好的提示（通用兜底文案按 locale 双语；
 * 各 API 路由自带的 raw message 大多仍是中文——覆盖到的路由已单独处理，
 * 未覆盖到的路由这里无法逐条翻译，属已知范围外）
 */
function humanizeError(status: number, code: string | undefined, raw: string | undefined): string {
  const isEn = isEnLocale()
  // 已知业务错误码
  switch (code) {
    case 'INSUFFICIENT_STOCK':
      return raw || (isEn ? 'Insufficient stock, cannot place order' : '库存不足，无法下单')
    case 'RATE_LIMIT':
      return raw || (isEn ? 'Too many attempts, please try again later' : '操作过于频繁，请稍后再试')
    case 'MFA_REQUIRED':
      return raw || (isEn ? 'Please enter the 6-digit code' : '请输入 6 位动态码')
  }

  // 按 status 分档
  if (status === 400 && raw) return raw
  if (status === 401) return isEn ? 'Session expired, please log in again' : '登录已过期，请重新登录'
  if (status === 403) return raw || (isEn ? 'You do not have permission to perform this action' : '您没有权限执行此操作')
  if (status === 404) return raw || (isEn ? 'The requested resource was not found' : '请求的资源不存在')
  if (status === 409) return raw || (isEn ? 'Conflicts with current state, please refresh and retry' : '操作与当前状态冲突，请刷新后重试')
  if (status === 429) return isEn ? 'Too many requests, please wait and try again' : '请求过于频繁，请稍候再试'
  if (status >= 500)   return isEn ? 'Server temporarily unavailable, please try again later' : '服务器暂时不可用，请稍后重试'
  return raw || (isEn ? `Request failed (HTTP ${status})` : `请求失败 (HTTP ${status})`)
}

export async function api<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  let res: Response
  const tokenAtRequestTime = getToken()
  try {
    // FormData 请求不能带 Content-Type: application/json，浏览器要自己加 multipart boundary
    const baseHeaders = authHeaders()
    if (options?.body instanceof FormData) delete baseHeaders['Content-Type']
    res = await fetch(path, {
      ...options,
      headers: { ...baseHeaders, ...(options?.headers ?? {}) },
    })
  } catch (netErr) {
    // TypeError: Failed to fetch → 网络断
    const isEn = isEnLocale()
    throw new ApiError(isEn ? 'Cannot reach the server, please check your connection and retry' : '连接不上服务器，请检查网络后重试', 0, 'NETWORK_ERROR',
      (netErr as Error)?.message)
  }

  // 401：token 过期、未登录，或权限被管理员改过（PERMISSION_CHANGED）。都要重新登录，
  // 但**原因要说对** —— 权限刚被调整的人看到「登录已过期」会以为系统抽风，
  // 转头去问 IT，而不是去问改他权限的人。
  if (res.status === 401) {
    const isEn = isEnLocale()
    let permissionChanged = false
    try {
      const body = await res.json()
      permissionChanged = body?.error === 'PERMISSION_CHANGED'
    } catch { /* 空响应体，按普通过期处理 */ }

    const message = permissionChanged
      ? (isEn ? 'Your permissions were changed, please sign in again' : '权限已变更，请重新登录')
      : (isEn ? 'Session expired, please log in again' : '登录已过期，请重新登录')

    // 这次失败请求发出时用的 token，若已不是 localStorage 里当前的 token，
    // 说明这期间已经有另一次登录/登出把状态换掉了 —— 不能顺手把刚写入的新 token
    // 清掉、把用户重新弹回登录页（多标签页下会出现"明明刚登录成功却又被踢出"）
    if (typeof window !== 'undefined' && localStorage.getItem('veggie_token') === tokenAtRequestTime) {
      localStorage.removeItem('veggie_token')
      localStorage.removeItem('veggie_user')
      // 同步清掉服务端下发的 HttpOnly cookie，否则页面级 middleware 仍认为已登录，
      // 出现"页面能开、一操作就被踢"的分裂状态
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
      const target = `${isEn ? '/en/enter' : '/enter'}${permissionChanged ? '?reason=permission-changed' : ''}`
      // 延迟一点跳转，让 toast 有机会显示
      setTimeout(() => { window.location.href = target }, 300)
    }
    throw new ApiError(message, 401, permissionChanged ? 'PERMISSION_CHANGED' : undefined)
  }

  // 403 + PASSWORD_CHANGE_REQUIRED：账号还在用初始密码，除了改密什么都不让做。
  // 直接把人送到改密页，否则他会在一个每次点击都报错的界面里打转。
  if (res.status === 403) {
    const clone = res.clone()
    try {
      const body = await clone.json()
      if (body?.error === 'PASSWORD_CHANGE_REQUIRED') {
        const isEn = isEnLocale()
        const msg = isEn ? 'Please change your password first' : '请先修改密码'
        if (typeof window !== 'undefined' && !window.location.pathname.includes('/change-password')) {
          setTimeout(() => {
            window.location.href = `${isEn ? '/en' : ''}/change-password?forced=1`
          }, 300)
        }
        throw new ApiError(msg, 403, 'PASSWORD_CHANGE_REQUIRED')
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      /* 不是这个 code，落到下面的通用处理 */
    }
  }

  if (!res.ok) {
    let rawMessage: string | undefined
    let code: string | undefined
    let details: Record<string, unknown> | undefined
    try {
      const body = await res.json()
      rawMessage = body.message ?? body.error
      code = body.error && typeof body.error === 'string' &&
             /^[A-Z_]+$/.test(body.error) ? body.error : undefined
      const rest: Record<string, unknown> = {}
      for (const k of Object.keys(body ?? {})) {
        if (k !== 'error' && k !== 'message') rest[k] = body[k]
      }
      if (Object.keys(rest).length > 0) details = rest
    } catch { /* ignore */ }

    throw new ApiError(humanizeError(res.status, code, rawMessage), res.status, code, rawMessage, details)
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T

  try {
    return await res.json()
  } catch {
    return undefined as unknown as T
  }
}

export const apiGet = <T = unknown>(path: string) =>
  api<T>(path, { method: 'GET' })

export const apiPost = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const apiPut = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) })

export const apiPatch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

export const apiDelete = <T = unknown>(path: string) =>
  api<T>(path, { method: 'DELETE' })

export const apiUpload = <T = unknown>(path: string, form: FormData) =>
  api<T>(path, { method: 'POST', body: form })
