import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog, diffChanges } from '@/lib/action-log'
import bcrypt from 'bcryptjs'

const USER_TRACKED_FIELDS = ['name', 'role', 'isActive']

// PUT /api/users/[id] — 修改姓名、角色、isActive、newPassword（仅 OPERATOR）
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const { name, role, roles, isActive, newPassword } = await req.json()

      const VALID_ROLES = ['OPERATOR', 'RESTAURANT', 'PICKER', 'SORTER', 'DRIVER', 'BOSS', 'FINANCE', 'WAREHOUSE', 'SALES', 'DISPATCH', 'OTHER']

      const updateData: Record<string, unknown> = {}
      if (name !== undefined) updateData.name = String(name).trim().slice(0, 100)
      // SSOT: role 与 roles[] 必须同步,否则前端按 role、后端按 roles[] 判权限会分裂。
      // 显式传 roles[] → 以它为准,role 取首项;只传 role → roles=[role]。
      if (Array.isArray(roles)) {
        const cleaned = roles.map(String).filter((r: string) => VALID_ROLES.includes(r))
        if (cleaned.length === 0) return NextResponse.json({ error: '无效角色' }, { status: 400 })
        updateData.roles = cleaned
        updateData.role = cleaned[0]
      } else if (role !== undefined) {
        if (!VALID_ROLES.includes(role)) return NextResponse.json({ error: '无效角色' }, { status: 400 })
        updateData.role = role
        updateData.roles = [role]
      }
      if (isActive !== undefined) updateData.isActive = Boolean(isActive)
      if (newPassword !== undefined) {
        if (String(newPassword).length < 6) return NextResponse.json({ error: '密码至少 6 位' }, { status: 400 })
        updateData.passwordHash = await bcrypt.hash(String(newPassword), 12)
      }

      const before = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, role: true, isActive: true },
      })
      if (!before) return NextResponse.json({ error: '用户不存在' }, { status: 404 })
      const user = await prisma.user.update({
        where: { id },
        data: updateData,
        select: { id: true, email: true, name: true, role: true, isActive: true, updatedAt: true },
      })

      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        user as unknown as Record<string, unknown>,
        USER_TRACKED_FIELDS,
      )
      // 密码改动只标记一次，不暴露明文/hash
      if (newPassword !== undefined) {
        changes.password = { before: '••••••', after: '（已重设）' }
      }

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'UPDATE', resource: 'user', resourceId: id,
        detail: `更新用户: ${user.name}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      })

      return NextResponse.json(serializeApi(user))
    } catch (error) {
      console.error('[PUT /api/users/[id]]', error)
      return NextResponse.json({ error: '更新用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}

// DELETE /api/users/[id] — 软删除（设 isActive=false，仅 OPERATOR）
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      if (id === me.userId) {
        return NextResponse.json({ error: '不能停用自己的账号' }, { status: 400 })
      }

      const user = await prisma.user.update({
        where: { id },
        data: { isActive: false },
        select: { id: true, name: true, email: true },
      })

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'DELETE', resource: 'user', resourceId: id,
        detail: `停用用户 ${user.name}（${user.email}）`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/users/[id]]', error)
      return NextResponse.json({ error: '停用用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}
