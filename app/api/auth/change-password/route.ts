import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export async function POST(req: Request) {
  try {
    const user = await requireAuth(req)
    const { oldPassword, newPassword } = await req.json()

    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 })
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: '新密码至少 6 位' }, { status: 400 })
    }

    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } })
    if (!dbUser) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 })
    }

    const valid = await bcrypt.compare(oldPassword, dbUser.passwordHash)
    if (!valid) {
      return NextResponse.json({ error: '当前密码错误' }, { status: 400 })
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({ where: { id: user.userId }, data: { passwordHash: hash } })

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[change-password]', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
