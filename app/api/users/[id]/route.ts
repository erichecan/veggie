import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog, diffChanges } from '@/lib/action-log'
import { forgetPermVersions } from '@/lib/rbac/perm-version'
import { assessNewPassword } from '@/lib/password-policy'
import bcrypt from 'bcryptjs'

const USER_TRACKED_FIELDS = ['name', 'role', 'isActive']

// PUT /api/users/[id] — 修改姓名、角色、isActive、newPassword（仅 OPERATOR）
/**
 * 沿 managerId 链向上走，看会不会绕回 userId。
 * 只做一层团队不代表可以不防环：A→B→A 会让「谁是谁的下属」自相矛盾，
 * 而且以后要是把团队改成多层，这里就是无限递归。
 * 返回环的路径（给用户看得懂的报错），无环返回 null。
 */
async function wouldFormCycle(userId: string, newManagerId: string): Promise<string | null> {
  const path: string[] = []
  let cursor: string | null = newManagerId
  for (let depth = 0; depth < 32 && cursor; depth++) {
    if (cursor === userId) return [...path, '…'].join(' → ') || '直接互为上下级'
    const node: { name: string; managerId: string | null } | null = await prisma.user.findUnique({
      where: { id: cursor },
      select: { name: true, managerId: true },
    })
    if (!node) return null
    path.push(node.name)
    cursor = node.managerId
  }
  return null
}

/**
 * 把 legacy 的 roles[] 同步成 UserRoleLink，并 bump permVersion 逼对方重新登录。
 * 预置角色的 code 是 legacy 角色名的小写形式（见 20260807000001 迁移）。
 */
async function syncRoleLinks(userId: string, legacyRoles: string[]): Promise<void> {
  const codes = legacyRoles.map((r) => r.toLowerCase())
  const target = await prisma.appRole.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.userRoleLink.deleteMany({ where: { userId } }),
    ...target.map((r) =>
      prisma.userRoleLink.create({ data: { userId, roleId: r.id } }),
    ),
    // 权限变了就作废对方手里的 token（已定决策 5：强制重新登录）
    prisma.user.update({ where: { id: userId }, data: { permVersion: { increment: 1 } } }),
  ])
  forgetPermVersions([userId])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const { name, role, roles, isActive, newPassword, managerId } = await req.json()

      // ⛔ 与 prisma enum Role 保持一致。EXTERNAL_SALES 是 2026-08-06 加的，
      //    这份白名单当时漏了更新 —— 管理员因此一直设不了外部销售这个角色。
      const VALID_ROLES = ['OPERATOR', 'RESTAURANT', 'PICKER', 'SORTER', 'DRIVER', 'BOSS', 'FINANCE', 'WAREHOUSE', 'SALES', 'EXTERNAL_SALES', 'DISPATCH', 'OTHER']

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

      // 直属上级 —— DataScope.TEAM 靠它算下属（见 lib/row-scope.ts）
      if (managerId !== undefined) {
        const next = managerId === null || managerId === '' ? null : String(managerId)
        if (next !== null) {
          if (next === id) {
            return NextResponse.json({ error: '不能把自己设为自己的上级' }, { status: 400 })
          }
          const cycle = await wouldFormCycle(id, next)
          if (cycle) {
            return NextResponse.json({ error: `会形成汇报环：${cycle}` }, { status: 400 })
          }
          const exists = await prisma.user.findUnique({ where: { id: next }, select: { id: true } })
          if (!exists) return NextResponse.json({ error: '上级不存在' }, { status: 400 })
        }
        updateData.managerId = next
      }
      const before = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, role: true, isActive: true },
      })
      if (!before) return NextResponse.json({ error: '用户不存在' }, { status: 404 })

      // ⛔ 这条路走的是**管理员替别人设密码**，比自助改密更危险，校验却一度更松
      //    （只看 length >= 6）。两条路必须过同一个 assessNewPassword ——
      //    否则强度策略等于只对愿意遵守的人生效。
      //    黑名单里的邮箱名/姓名比对用的是**被改的那个人**，不是操作者。
      if (newPassword !== undefined) {
        const verdict = assessNewPassword(String(newPassword), {
          email: before.email,
          name: before.name,
        })
        if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 })
        updateData.passwordHash = await bcrypt.hash(String(newPassword), 12)
        // 密码变了就作废对方手里的 token，与自助改密同一口径（决策 5 / I1）
        updateData.permVersion = { increment: 1 }
      }
      const user = await prisma.user.update({
        where: { id },
        data: updateData,
        select: { id: true, email: true, name: true, role: true, isActive: true, updatedAt: true },
      })

      // ⛔ 过渡期同步：权限判定的真相是 UserRoleLink（20260807 起），而这个页面改的
      // 还是 legacy 的 role/roles[]。不同步的话表现是「在用户管理里改了角色，权限纹丝不动」
      // —— 正是可配置权限体系要杜绝的「配了但不生效」。
      // T11 的权限中心上线后，角色分配走 /api/rbac，那时这段可以删。
      if (Array.isArray(updateData.roles)) {
        await syncRoleLinks(id, updateData.roles as string[])
      }

      // permVersion 已经 +1，但 withAuth 那侧有 30 秒缓存 —— 不清掉的话
      // 被改密码的人还能拿旧 token 再用半分钟。
      if (newPassword !== undefined) forgetPermVersions([id])

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

      // ⛔ isActive 只在**登录时**校验一次（app/api/auth/login/route.ts），withAuth 是纯验签
      //    + permVersion，全程不查这个字段。所以只写 isActive=false 的话，被停用的人
      //    手里那张 token 还能继续用满 7 天 —— 离职当天停用，第二天照样能下单。
      //    permVersion +1 才是真正把人踢出去的那一下。
      const user = await prisma.user.update({
        where: { id },
        data: { isActive: false, permVersion: { increment: 1 } },
        select: { id: true, name: true, email: true },
      })
      forgetPermVersions([id])

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
