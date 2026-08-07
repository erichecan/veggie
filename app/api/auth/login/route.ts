import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { signToken } from '@/lib/auth'
import { resolveUserPermissions } from '@/lib/rbac/resolve'
import { writeLog } from '@/lib/action-log'
import { rateLimit } from '@/lib/rate-limit'
import { verifyTotp } from '@/lib/totp'

export async function POST(req: Request) {
  // 防暴力破解：每 IP 每分钟最多 10 次登录尝试
  const denied = rateLimit(req, { id: 'login', max: 10, windowMs: 60_000 })
  if (denied) return denied

  try {
    const { email, password, mfaCode } = await req.json() as {
      email?: string
      password?: string
      mfaCode?: string
    }

    if (!email || !password) {
      return NextResponse.json({ error: '邮箱和密码不能为空' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return NextResponse.json({ error: '邮箱或密码错误' }, { status: 401 })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      return NextResponse.json({ error: '邮箱或密码错误' }, { status: 401 })
    }

    // 检查账号是否被停用
    if (user.isActive === false) {
      return NextResponse.json({ error: '账号已停用，请联系管理员' }, { status: 403 })
    }

    // MFA 检查（用户启用了 MFA 必须提交 6 位 TOTP）
    // 字段名: mfaEnabled/mfaSecret（schema 已加，Prisma generate 后可强类型访问）
    const anyUser = user as unknown as { mfaEnabled?: boolean; mfaSecret?: string | null }
    if (anyUser.mfaEnabled && anyUser.mfaSecret) {
      if (!mfaCode) {
        return NextResponse.json({
          error: 'MFA_REQUIRED',
          message: '请输入 6 位动态码',
          mfaRequired: true,
        }, { status: 401 })
      }
      const ok = await verifyTotp(anyUser.mfaSecret, mfaCode)
      if (!ok) {
        return NextResponse.json({ error: '动态码错误或已过期' }, { status: 401 })
      }
    }

    // roles[] 优先（多角色），role 兼容字段保留
    const userRoles = (user as unknown as { roles?: string[] | null }).roles
    const rolesArr = Array.isArray(userRoles) && userRoles.length > 0
      ? userRoles.map(String)
      : [String(user.role)]
    // 权限集在登录时算一次并编成位图塞进 token —— 之后每次请求的判定是纯位运算，
    // 不再查库。middleware 跑 Edge runtime 用不了 Prisma，也只能这么办。
    const perms = await resolveUserPermissions(user.id)

    const token = await signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      roles: rolesArr,
      name: user.name,
      customerId: user.customerId,
      pm: perms.bitmap,
      ds: perms.dataScope,
      pv: perms.permVersion,
    })

    // 记录 lastLoginAt（schema 已加，但 Prisma client 需要 generate 才能认字段）
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() } as unknown as { lastLoginAt: Date },
      })
    } catch {
      // 字段未生成时跳过，不阻塞登录
    }

    await writeLog({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      action: 'LOGIN',
      resource: 'user',
      resourceId: user.id,
      detail: `${user.name}（${user.role}）登录系统`,
    })

    return NextResponse.json({
      token,
      user: {
        userId: user.id,
        email: user.email,
        role: user.role,
        roles: rolesArr,
        name: user.name,
        customerId: user.customerId,
        // 与 token 里的 pm/ds 同源。前端只用它做显隐与页面守卫，
        // 真正的拦截仍在 middleware 与路由层 —— 前端这份改了也越不了权。
        pm: perms.bitmap,
        ds: perms.dataScope,
      },
    })
  } catch (error) {
    console.error('[login] error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
