import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { signToken } from '@/lib/auth'
import { resolveUserPermissions } from '@/lib/rbac/resolve'
import { writeLog } from '@/lib/action-log'
import { rateLimit } from '@/lib/rate-limit'
import { checkLocked, recordFailure, recordSuccess } from '@/lib/login-throttle'
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

    // ⛔ 按账号锁定，与来源 IP 无关 —— 上面那道按 IP 的限流，换个 IP 就重新开始，
    // 对着一个账号跑字典只要来源分散就形同虚设。这一道换多少 IP 都绕不过。
    // 锁定期内即使密码正确也拒绝：否则「响应变了」会告诉攻击者刚才蒙对了。
    const locked = checkLocked(email)
    if (locked.locked) {
      return NextResponse.json(
        {
          error: 'ACCOUNT_LOCKED',
          message: `登录失败次数过多，请 ${locked.retryAfterSec} 秒后再试`,
        },
        { status: 429, headers: { 'Retry-After': String(locked.retryAfterSec) } },
      )
    }

    const user = await prisma.user.findUnique({ where: { email } })

    // 账号不存在也要记失败并走同一条返回路径 —— 分开处理的话，
    // 「哪个邮箱存在」会从行为差异里漏出去，等于送一份用户名枚举。
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false
    if (!user || !valid) {
      const after = recordFailure(email)
      if (after.locked) {
        return NextResponse.json(
          {
            error: 'ACCOUNT_LOCKED',
            message: `登录失败次数过多，请 ${after.retryAfterSec} 秒后再试`,
          },
          { status: 429, headers: { 'Retry-After': String(after.retryAfterSec) } },
        )
      }
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
        // 动态码也要计入失败：否则密码这关一过，6 位数字就可以无限试
        recordFailure(email)
        return NextResponse.json({ error: '动态码错误或已过期' }, { status: 401 })
      }
    }

    // 到这里说明凭据完全正确，把这个账号的失败计数清零
    recordSuccess(email)

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
      // 弱口令账号：token 里带上标记，withAuth 据此挡住除改密外的一切操作
      mcp: user.mustChangePassword || undefined,
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
        // 前端据此跳改密页。真正的拦截在 withAuth，改浏览器里这个值没用
        mustChangePassword: user.mustChangePassword,
      },
    })
  } catch (error) {
    console.error('[login] error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
