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
  constructor(message: string, status: number, code?: string, rawMessage?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.rawMessage = rawMessage
  }
}

/**
 * 把后端错误码翻译成用户友好的中文提示
 */
function humanizeError(status: number, code: string | undefined, raw: string | undefined): string {
  // 已知业务错误码
  switch (code) {
    case 'INSUFFICIENT_STOCK':
      return raw || '库存不足，无法下单'
    case 'RATE_LIMIT':
      return raw || '操作过于频繁，请稍后再试'
    case 'MFA_REQUIRED':
      return raw || '请输入 6 位动态码'
  }

  // 按 status 分档
  if (status === 400 && raw) return raw
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return raw || '您没有权限执行此操作'
  if (status === 404) return raw || '请求的资源不存在'
  if (status === 409) return raw || '操作与当前状态冲突，请刷新后重试'
  if (status === 429) return '请求过于频繁，请稍候再试'
  if (status >= 500)   return '服务器暂时不可用，请稍后重试'
  return raw || `请求失败 (HTTP ${status})`
}

export async function api<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  let res: Response
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
    throw new ApiError('连接不上服务器，请检查网络后重试', 0, 'NETWORK_ERROR',
      (netErr as Error)?.message)
  }

  // 401：token 过期或未登录，自动跳转登录页
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('veggie_token')
      localStorage.removeItem('veggie_user')
      // 延迟一点跳转，让 toast 有机会显示
      setTimeout(() => { window.location.href = '/enter' }, 300)
    }
    throw new ApiError('登录已过期，请重新登录', 401)
  }

  if (!res.ok) {
    let rawMessage: string | undefined
    let code: string | undefined
    try {
      const body = await res.json()
      rawMessage = body.message ?? body.error
      code = body.error && typeof body.error === 'string' &&
             /^[A-Z_]+$/.test(body.error) ? body.error : undefined
    } catch { /* ignore */ }

    throw new ApiError(humanizeError(res.status, code, rawMessage), res.status, code, rawMessage)
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
