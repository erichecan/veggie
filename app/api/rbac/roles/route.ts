import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { RbacError, assertValidScope, sanitizePermissions } from '@/lib/rbac/admin'

/** GET /api/rbac/roles —— 角色列表，含每个角色挂了多少人 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const roles = await prisma.appRole.findMany({
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
      select: {
        id: true, code: true, name: true, description: true,
        isSystem: true, dataScope: true, permissions: true,
        _count: { select: { users: true } },
      },
    })
    return NextResponse.json({
      roles: roles.map((r) => ({
        id: r.id, code: r.code, name: r.name, description: r.description,
        isSystem: r.isSystem, dataScope: r.dataScope,
        permissions: r.permissions, permissionCount: r.permissions.length,
        userCount: r._count.users,
      })),
    })
  }, { require: 'system.rbac.read' })
}

/** POST /api/rbac/roles —— 新建角色（可从现有角色复制权限） */
export async function POST(req: Request) {
  return withAuth(req, async (me) => {
    try {
      const body = await req.json()
      const code = String(body.code ?? '').trim().toLowerCase()
      const name = String(body.name ?? '').trim()

      if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) {
        throw new RbacError('角色标识只能用小写字母、数字与下划线，字母开头，2–40 位')
      }
      if (!name) throw new RbacError('角色名称不能为空')

      const dup = await prisma.appRole.findUnique({ where: { code }, select: { id: true } })
      if (dup) throw new RbacError(`角色标识 ${code} 已存在`, 409)

      const { ids, unknown } = sanitizePermissions(body.permissions)
      if (unknown.length > 0) {
        throw new RbacError(`这些权限点不存在：${unknown.join('、')}`)
      }

      const role = await prisma.appRole.create({
        data: {
          code, name,
          description: body.description ? String(body.description).slice(0, 500) : null,
          isSystem: false,          // ⛔ 页面上建的角色永远不是系统角色
          dataScope: assertValidScope(body.dataScope ?? 'ALL'),
          permissions: ids,
        },
        select: { id: true, code: true, name: true, dataScope: true, permissions: true },
      })

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'CREATE', resource: 'app_role', resourceId: role.id,
        detail: `新建角色「${name}」(${code})，${ids.length} 个权限点，范围 ${role.dataScope}`,
      })

      // 新角色还没人挂，不需要作废任何 token
      return NextResponse.json({ role }, { status: 201 })
    } catch (e) {
      if (e instanceof RbacError) return NextResponse.json({ error: e.message }, { status: e.status })
      console.error('[rbac] create role failed', e)
      return NextResponse.json({ error: '创建角色失败' }, { status: 500 })
    }
  }, { require: 'system.rbac.manage' })
}
