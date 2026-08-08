import { NextResponse } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import { decodePermissions } from './rbac/bitmap'
import { legacyRolesHavePermission } from './rbac/legacy-roles'
import { isTokenRevoked } from './rbac/perm-version'

// ─── JWT_SECRET 懒加载 ───────────────────────────────────────────────────────
// 不在模块加载时 throw：Docker build 期间 Secret Manager 的值尚未注入，
// 模块级 throw 会导致 next build 的静态分析阶段崩溃。
// 改为在第一次实际调用 getSecret() 时校验，确保只在真正处理请求时失败。
let _secret: Uint8Array | null = null

function getSecret(): Uint8Array {
  if (_secret) return _secret
  const rawSecret = process.env.JWT_SECRET
  if (!rawSecret || rawSecret.length < 32) {
    const msg = '[auth] JWT_SECRET is missing or shorter than 32 chars. ' +
      'Set it in .env.local or GCP Secret Manager.'
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg)
    }
    // 开发环境：warning + 随机值（只影响本次进程）
    console.warn(msg)
    _secret = new TextEncoder().encode(
      'dev-only-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    )
  } else {
    _secret = new TextEncoder().encode(rawSecret)
  }
  return _secret
}

export interface JwtPayload {
  userId: string
  email: string
  /** 主角色（兼容旧客户端 / 老 token） */
  role: string
  /** 全部角色 — 一个账号可同时是 OPERATOR + SALES 等。空数组时回退到 role */
  roles?: string[]
  name: string
  customerId?: string | null

  // ── 可配置权限体系（20260807）───────────────────────────────────────────
  // 判定真相是这三个字段，上面的 role/roles 只留作兼容与显示。
  // 之所以塞进 token 而不是查库：middleware 跑 Edge runtime，用不了 Prisma。
  /** 权限位图（base64url），位序 = catalog 的 sortKey */
  pm?: string
  /** 数据范围 ALL | TEAM | OWN */
  ds?: string
  /** 权限版本号。落后于 User.permVersion 就强制重新登录 */
  pv?: number
}

/** 把 user 拍平成"该用户拥有的角色集合"，供 withAuth / 前端做权限判断 */
export function effectiveRoles(p: { role?: string | null; roles?: string[] | null }): string[] {
  const arr = Array.isArray(p.roles) ? p.roles.filter(Boolean).map(String) : []
  if (arr.length > 0) return arr
  return p.role ? [String(p.role)] : []
}

export async function signToken(payload: JwtPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(getSecret())
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, getSecret())
  return payload as unknown as JwtPayload
}

/**
 * tryAuth — 尝试解析 JWT，不抛错。用于可选认证场景（如 GET 接口根据角色自动过滤）
 */
export async function tryAuth(request: Request): Promise<JwtPayload | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    return await verifyToken(authHeader.slice(7))
  } catch {
    return null
  }
}

export async function requireAuth(request: Request): Promise<JwtPayload> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw Object.assign(new Error('未授权访问'), { status: 401 })
  }
  const token = authHeader.slice(7)
  try {
    return await verifyToken(token)
  } catch {
    throw Object.assign(new Error('Token 无效或已过期'), { status: 401 })
  }
}

/** withAuth 的第三个参数：老写法是角色数组，新写法是权限点要求 */
export type AuthGate =
  | string[]
  | {
      /** 需要的权限点；数组表示任一即可 */
      require: string | string[]
    }

/**
 * 当前用户有没有这些权限点里的任意一个。
 *
 * handler 内部要做**比路由更细**的判定时用它 —— 典型是同一个端点承载多个动作
 * （`PATCH /api/purchase-orders/[id]` 的 action 既有「改」也有「批」），
 * route-map 只认 URL + method，分不开这两件事。
 *
 * 旧 token 的处理与 withAuth 一致：没有位图就走角色反查，不是直接放行。
 */
export function userHasPermission(user: JwtPayload, need: string | string[]): boolean {
  const arr = typeof need === 'string' ? [need] : need
  return user.pm
    ? decodePermissions(user.pm).hasAny(arr)
    : legacyRolesHavePermission(effectiveRoles(user), arr)
}

/**
 * withAuth — 统一认证包装器
 * 在执行任何业务逻辑之前先验证 JWT，验证失败直接返回 401/403。
 *
 * 两种闸门写法：
 *   withAuth(req, h, { require: 'purchase.order.approve' })   ← 新，按权限点
 *   withAuth(req, h, ['OPERATOR'])                            ← 旧，按角色（过渡期保留）
 *
 * 迁移期间两者并存是有意的：150 个 handler 分批改，一次改完风险太大
 * （8/6 踩过：批量脚本把 allowedRoles 数组插进了注释里，只能回滚重做）。
 *
 * @param request 原始请求对象
 * @param handler 认证通过后执行的处理函数，接收当前用户信息
 * @param gate    可选：权限点要求或角色列表
 */
export async function withAuth(
  request: Request,
  handler: (user: JwtPayload) => Promise<Response>,
  gate?: AuthGate
): Promise<Response> {
  let user: JwtPayload
  try {
    user = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: '未授权访问，请先登录' }, { status: 401 })
  }

  // 权限被改过的 token 一律作废（决策 5：不静默重签，改完就踢）。
  // 前端认 PERMISSION_CHANGED 这个 code，跳登录页时才能说清「为什么把我踢出来」，
  // 而不是笼统的一句「登录已过期」—— 后者会让人以为是系统抽风。
  if (await isTokenRevoked(user)) {
    return NextResponse.json(
      { error: 'PERMISSION_CHANGED', message: '权限已变更，请重新登录' },
      { status: 401 },
    )
  }

  if (Array.isArray(gate) && gate.length > 0) {
    const own = effectiveRoles(user)
    if (!own.some(r => gate.includes(r))) {
      return NextResponse.json({ error: `权限不足，需要角色: ${gate.join(' / ')}` }, { status: 403 })
    }
  } else if (gate && !Array.isArray(gate)) {
    const need = typeof gate.require === 'string' ? [gate.require] : gate.require
    // ⛔ 旧 token（部署前签发的，没有 pm 字段）必须走角色反查，不能直接判位图 ——
    // 空位图会让这 154 个接口对所有还没重新登录的人全部 403。
    // 也不能「没位图就跳过检查」：那样只剩 middleware 一层，比改造前更宽松。
    // 反查表等价于改造前的 allowedRoles，见 lib/rbac/legacy-roles.ts。
    if (!userHasPermission(user, need)) {
      return NextResponse.json({ error: `权限不足，需要: ${need.join(' 或 ')}` }, { status: 403 })
    }
  }

  return handler(user)
}
