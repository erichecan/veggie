import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import {
  RbacError, assertAdminSurvives, assertValidScope,
  invalidateTokens, sanitizePermissions, userIdsOfRole,
} from '@/lib/rbac/admin'

/** PUT /api/rbac/roles/[id] —— 改角色的名称 / 权限点 / 数据范围 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const body = await req.json()
      const before = await prisma.appRole.findUnique({
        where: { id },
        select: { id: true, code: true, name: true, isSystem: true, dataScope: true, permissions: true },
      })
      if (!before) return NextResponse.json({ error: '角色不存在' }, { status: 404 })

      const data: Record<string, unknown> = {}
      if (body.name !== undefined) {
        const name = String(body.name).trim()
        if (!name) throw new RbacError('角色名称不能为空')
        data.name = name
      }
      if (body.description !== undefined) {
        data.description = body.description ? String(body.description).slice(0, 500) : null
      }
      if (body.dataScope !== undefined) data.dataScope = assertValidScope(body.dataScope)
      if (body.permissions !== undefined) {
        const { ids, unknown } = sanitizePermissions(body.permissions)
        if (unknown.length > 0) throw new RbacError(`这些权限点不存在：${unknown.join('、')}`)
        data.permissions = ids
      }
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: '没有要修改的内容' }, { status: 400 })
      }

      // ⛔ 系统角色的 code 与 isSystem 永远不可改 —— 平迁基线与迁移脚本都按 code 认它们
      const affected = await userIdsOfRole(prisma, id)

      const role = await prisma.$transaction(async (tx) => {
        const updated = await tx.appRole.update({
          where: { id }, data,
          select: { id: true, code: true, name: true, dataScope: true, permissions: true, isSystem: true },
        })
        // 在事务里校验，不过就整体回滚 —— 提交后再查已经晚了，那时已经锁死
        await assertAdminSurvives(tx as never, `修改角色「${updated.name}」`)
        await invalidateTokens(tx as never, affected)
        return updated
      })

      const added = role.permissions.filter((p) => !before.permissions.includes(p))
      const removed = before.permissions.filter((p) => !role.permissions.includes(p))
      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'UPDATE', resource: 'app_role', resourceId: id,
        detail:
          `修改角色「${before.name}」(${before.code})：` +
          (added.length ? `新增 ${added.length} 个权限点(${added.slice(0, 8).join('、')}${added.length > 8 ? '…' : ''})；` : '') +
          (removed.length ? `移除 ${removed.length} 个权限点(${removed.slice(0, 8).join('、')}${removed.length > 8 ? '…' : ''})；` : '') +
          (before.dataScope !== role.dataScope ? `范围 ${before.dataScope}→${role.dataScope}；` : '') +
          `影响 ${affected.length} 人，已要求其重新登录`,
      })

      return NextResponse.json({ role, affectedUsers: affected.length })
    } catch (e) {
      if (e instanceof RbacError) return NextResponse.json({ error: e.message }, { status: e.status })
      console.error('[rbac] update role failed', e)
      return NextResponse.json({ error: '修改角色失败' }, { status: 500 })
    }
  }, { require: 'system.rbac.manage' })
}

/** DELETE /api/rbac/roles/[id] —— 删除角色。系统角色不可删；有人在用要先说清楚 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const role = await prisma.appRole.findUnique({
        where: { id },
        select: { id: true, code: true, name: true, isSystem: true, _count: { select: { users: true } } },
      })
      if (!role) return NextResponse.json({ error: '角色不存在' }, { status: 404 })

      // 预置的 12 个角色是平迁基线的锚点，删了之后现网账号会失去权限来源
      if (role.isSystem) {
        throw new RbacError(`「${role.name}」是预置角色，不能删除（可以改它的权限）`, 409)
      }

      const affected = await userIdsOfRole(prisma, id)
      const force = new URL(req.url).searchParams.get('force') === 'true'
      if (affected.length > 0 && !force) {
        throw new RbacError(
          `还有 ${affected.length} 个账号挂着「${role.name}」，删除后他们会失去这部分权限。` +
            `确认要删就带上 ?force=true`,
          409,
        )
      }

      await prisma.$transaction(async (tx) => {
        await tx.appRole.delete({ where: { id } })   // UserRoleLink 由外键级联删除
        await assertAdminSurvives(tx as never, `删除角色「${role.name}」`)
        await invalidateTokens(tx as never, affected)
      })

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'DELETE', resource: 'app_role', resourceId: id,
        detail: `删除角色「${role.name}」(${role.code})，影响 ${affected.length} 人`,
      })
      return NextResponse.json({ ok: true, affectedUsers: affected.length })
    } catch (e) {
      if (e instanceof RbacError) return NextResponse.json({ error: e.message }, { status: e.status })
      console.error('[rbac] delete role failed', e)
      return NextResponse.json({ error: '删除角色失败' }, { status: 500 })
    }
  }, { require: 'system.rbac.manage' })
}
