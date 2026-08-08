import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { rateLimit } from '@/lib/rate-limit'
import { assessNewPassword } from '@/lib/password-policy'

/**
 * POST /api/auth/change-password —— 用户自助改密码
 *
 * 这是「必须改密」状态下唯一放行的写操作（见 lib/auth.ts 的 PASSWORD_CHANGE_EXEMPT），
 * 所以它自己得把关严：必须验旧密码、必须过强度校验、必须真的换掉。
 */
export async function POST(req: Request) {
  // 验旧密码等于又开了一个爆破面，同样限流
  const denied = rateLimit(req, { id: 'change-password', max: 10, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (me) => {
    try {
      const { currentPassword, newPassword } = await req.json() as {
        currentPassword?: string
        newPassword?: string
      }
      if (!currentPassword || !newPassword) {
        return NextResponse.json({ error: '请填写当前密码与新密码' }, { status: 400 })
      }

      const user = await prisma.user.findUnique({
        where: { id: me.userId },
        select: { id: true, email: true, name: true, passwordHash: true, role: true },
      })
      if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 })

      const ok = await bcrypt.compare(currentPassword, user.passwordHash)
      if (!ok) {
        return NextResponse.json({ error: '当前密码不正确' }, { status: 401 })
      }

      const verdict = assessNewPassword(newPassword, { email: user.email, name: user.name })
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.reason }, { status: 400 })
      }

      // 换汤不换药：新密码与旧的一样，等于没改
      if (await bcrypt.compare(newPassword, user.passwordHash)) {
        return NextResponse.json({ error: '新密码不能与当前密码相同' }, { status: 400 })
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(newPassword, 12),
          mustChangePassword: false,
          // 密码变了，手里的 token 也该作废 —— 改密的常见动机就是「怀疑被别人登了」，
          // 不作废的话对方那张 token 还能继续用满 7 天。
          permVersion: { increment: 1 },
        },
      })

      await writeLog({
        userId: user.id, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'user_password', resourceId: user.id,
        detail: `${user.name} 自助修改了登录密码`,
      })

      return NextResponse.json({
        ok: true,
        message: '密码已修改，请用新密码重新登录',
      })
    } catch (e) {
      console.error('[change-password]', e)
      return NextResponse.json({ error: '修改密码失败' }, { status: 500 })
    }
  })
}
