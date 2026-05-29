import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { sendPasswordReset } from '@/lib/email'

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'

function generateTempPassword(len = 12): string {
  let result = ''
  // Use crypto.getRandomValues for secure random generation
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  for (const byte of arr) {
    result += CHARS[byte % CHARS.length]
  }
  return result
}

// POST /api/users/[id]/reset-password — 生成临时密码并返回（仅 OPERATOR）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const tempPassword = generateTempPassword()
      const passwordHash = await bcrypt.hash(tempPassword, 12)

      const user = await prisma.user.update({
        where: { id },
        data: { passwordHash },
        select: { id: true, name: true, email: true },
      })

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'UPDATE', resource: 'user', resourceId: id,
        detail: `重置用户 ${user.name}（${user.email}）的密码`,
      })

      // 发送密码重置邮件（不阻塞响应）
      if (process.env.RESEND_API_KEY) {
        sendPasswordReset({ to: user.email, userName: user.name, tempPassword })
          .catch((e) => console.error('[email] password reset failed:', e))
      }

      // 返回临时密码给运营人员，由其转告用户
      return NextResponse.json({ tempPassword, userName: user.name, email: user.email })
    } catch (error) {
      console.error('[POST /api/users/[id]/reset-password]', error)
      return NextResponse.json({ error: '重置密码失败' }, { status: 500 })
    }
  }, ['OPERATOR'])
}
