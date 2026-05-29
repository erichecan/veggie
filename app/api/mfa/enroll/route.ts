import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { generateSecret, otpauthUrl, verifyTotp } from '@/lib/totp'
import { writeLog } from '@/lib/action-log'

/**
 * /api/mfa/enroll
 * ============================================================================
 * 1) GET  → 给当前用户生成一个临时 TOTP secret + otpauth URL（返回给前端画二维码）
 *           但此时 mfaEnabled=false，直到用户校验成功才写入 mfaSecret
 * 2) POST → 校验一次 TOTP，成功则把 secret 写入 user 记录，mfaEnabled=true
 *
 * 客户端流程：
 *   1. GET /api/mfa/enroll → 拿到 secret + otpauthUrl
 *   2. 用户扫码（Google Authenticator 等）
 *   3. POST { secret, code: '123456' } 确认
 *   4. 成功后下次登录必须提供 TOTP code
 */

// 进程内缓存：待确认的 secret（10 分钟失效）
// 生产应该存 Redis，但 MFA enroll 是低频操作，单节点内存版足够。
const enrollCache = new Map<string, { secret: string; expiresAt: number }>()

function cleanup() {
  const now = Date.now()
  for (const [k, v] of enrollCache) if (v.expiresAt < now) enrollCache.delete(k)
}

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    cleanup()
    const secret = generateSecret()
    enrollCache.set(user.userId, { secret, expiresAt: Date.now() + 10 * 60 * 1000 })
    const url = otpauthUrl(user.email, 'Veggie Demo', secret)
    // 也直接返回 Google Charts 二维码 URL 方便前端渲染
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(url)}&size=200x200`
    return NextResponse.json({ secret, otpauthUrl: url, qrUrl })
  })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { secret, code } = await req.json() as { secret?: string; code?: string }
      if (!code) return NextResponse.json({ error: '验证码不能为空' }, { status: 400 })

      // 优先取客户端回传的 secret（来自 GET 响应）
      // 否则从进程缓存取（同会话 enroll）
      const useSecret = secret ?? enrollCache.get(user.userId)?.secret
      if (!useSecret) {
        return NextResponse.json({
          error: '找不到待绑定秘钥；请先 GET /api/mfa/enroll 生成二维码',
        }, { status: 400 })
      }

      const ok = await verifyTotp(useSecret, code)
      if (!ok) return NextResponse.json({ error: '验证码错误或已过期' }, { status: 401 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      await p.user.update({
        where: { id: user.userId },
        data: { mfaSecret: useSecret, mfaEnabled: true },
      })
      enrollCache.delete(user.userId)

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'user', resourceId: user.userId,
        detail: '启用 MFA (TOTP)',
      })

      return NextResponse.json({ ok: true, message: 'MFA 已启用。下次登录需提供 6 位动态码。' })
    } catch (error) {
      console.error('[POST /api/mfa/enroll]', error)
      return NextResponse.json({ error: '启用失败' }, { status: 500 })
    }
  })
}

// DELETE /api/mfa/enroll → 关闭 MFA（需输入当前 code 或由 OPERATOR 代操作）
export async function DELETE(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { code } = await req.json() as { code?: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const u = await p.user.findUnique({ where: { id: user.userId } })
      if (!u?.mfaSecret) {
        return NextResponse.json({ error: 'MFA 未启用' }, { status: 400 })
      }
      if (!code || !(await verifyTotp(u.mfaSecret, code))) {
        return NextResponse.json({ error: '验证码错误' }, { status: 401 })
      }
      await p.user.update({
        where: { id: user.userId },
        data: { mfaSecret: null, mfaEnabled: false },
      })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'user', resourceId: user.userId,
        detail: '关闭 MFA',
      })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/mfa/enroll]', error)
      return NextResponse.json({ error: '关闭失败' }, { status: 500 })
    }
  })
}
