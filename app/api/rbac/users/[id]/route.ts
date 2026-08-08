import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { RbacError, assertAdminSurvives, invalidateTokens } from '@/lib/rbac/admin'
import { isKnownPermission } from '@/lib/rbac/catalog'
import { combinePermissions, type DataScope } from '@/lib/rbac/resolve'

/**
 * prisma `enum Role` 的全部取值。自定义角色的 code 不在这里，写进 legacy 列会让
 * Prisma 直接抛校验错误 —— 必须先过滤。测试 `rbac-user-sync` 盯着它与 schema 同步。
 */
const LEGACY_ROLES = [
  'OPERATOR', 'RESTAURANT', 'PICKER', 'SORTER', 'DRIVER', 'BOSS',
  'FINANCE', 'WAREHOUSE', 'SALES', 'EXTERNAL_SALES', 'DISPATCH', 'OTHER',
] as const

/** GET /api/rbac/users/[id] —— 某人的角色、个人级例外，以及合并后的生效权限 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, isActive: true, managerId: true, permVersion: true,
        manager: { select: { id: true, name: true } },
        roleLinks: {
          select: { role: { select: { id: true, code: true, name: true, dataScope: true, permissions: true } } },
        },
        permissionGrants: {
          select: { permissionId: true, granted: true, reason: true, grantedBy: true },
        },
      },
    })
    if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 })

    const roles = user.roleLinks.map((l) => l.role)
    const effective = combinePermissions(
      roles.map((r) => ({ permissions: r.permissions, dataScope: r.dataScope as DataScope })),
      user.permissionGrants,
    )

    // 标出每个权限点是从哪来的 —— 配置页要能回答「他为什么能做这个」
    const fromRoles = new Set(roles.flatMap((r) => r.permissions))
    return NextResponse.json({
      user: {
        id: user.id, name: user.name, email: user.email, isActive: user.isActive,
        manager: user.manager, permVersion: user.permVersion,
      },
      roles: roles.map((r) => ({
        id: r.id, code: r.code, name: r.name, dataScope: r.dataScope,
        permissionCount: r.permissions.length,
      })),
      grants: user.permissionGrants,
      effective: {
        dataScope: effective.dataScope,
        total: effective.permissions.length,
        permissions: effective.permissions.map((p) => ({
          id: p,
          source: fromRoles.has(p) ? 'role' : 'grant',
        })),
      },
    })
  }, { require: 'system.rbac.read' })
}

/**
 * PUT /api/rbac/users/[id] —— 分配角色 / 设置个人级例外
 *
 * body: { roleIds?: string[], grants?: Array<{ permissionId, granted, reason? }> }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (me) => {
    try {
      const body = await req.json()
      const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true },
      })
      if (!target) return NextResponse.json({ error: '用户不存在' }, { status: 404 })

      let roleIds: string[] | null = null
      if (body.roleIds !== undefined) {
        const asStrings: string[] = (Array.isArray(body.roleIds) ? body.roleIds : []).map(
          (x: unknown) => String(x),
        )
        const wanted: string[] = Array.from(new Set(asStrings))
        const found = await prisma.appRole.findMany({
          where: { id: { in: wanted } }, select: { id: true },
        })
        if (found.length !== wanted.length) throw new RbacError('有角色不存在')
        roleIds = wanted
      }

      let grants: Array<{ permissionId: string; granted: boolean; reason: string | null }> | null = null
      if (body.grants !== undefined) {
        const raw = Array.isArray(body.grants) ? body.grants : []
        const bad = raw.filter((g: { permissionId?: unknown }) => !isKnownPermission(String(g?.permissionId ?? '')))
        if (bad.length > 0) {
          throw new RbacError(`这些权限点不存在：${bad.map((g: { permissionId?: unknown }) => String(g?.permissionId)).join('、')}`)
        }
        grants = raw.map((g: { permissionId: string; granted?: unknown; reason?: unknown }) => ({
          permissionId: String(g.permissionId),
          granted: Boolean(g.granted),
          reason: g.reason ? String(g.reason).slice(0, 200) : null,
        }))
      }

      if (roleIds === null && grants === null) {
        return NextResponse.json({ error: '没有要修改的内容' }, { status: 400 })
      }

      await prisma.$transaction(async (tx) => {
        if (roleIds !== null) {
          const ids: string[] = roleIds
          await tx.userRoleLink.deleteMany({ where: { userId: id } })
          if (ids.length > 0) {
            await tx.userRoleLink.createMany({
              data: ids.map((roleId) => ({ userId: id, roleId })),
              skipDuplicates: true,
            })
          }
          // legacy 字段跟着走，否则前端显示的角色与实际权限对不上。
          //
          // ⛔ 只能同步**枚举里存在**的角色。预置的 12 个角色 code 正好是 legacy 角色名的
          // 小写形式，直接 toUpperCase 就能对上；但页面上新建的角色（office_sales 之类）
          // 不在 `enum Role` 里，硬写进去 Prisma 直接报 PrismaClientValidationError ——
          // 表现是「建了角色，一分配给用户就 500」，正好把这个功能最核心的一步打死。
          //
          // 自定义角色在 legacy 列里无法表达，这是有意的：判定真相已经是权限点，
          // legacy 列只剩显示与旧 token 回退两个用途。一个 legacy 角色都对不上时落到
          // OTHER（零权限），免得旧 token 还按上一个角色放行。
          const codes = await tx.appRole.findMany({
            where: { id: { in: ids } }, select: { code: true },
          })
          const legacy = codes
            .map((c) => c.code.toUpperCase())
            .filter((r): r is (typeof LEGACY_ROLES)[number] =>
              (LEGACY_ROLES as readonly string[]).includes(r),
            )
          await tx.user.update({
            where: { id },
            data: {
              roles: legacy,
              role: (legacy[0] ?? 'OTHER') as never,
            },
          })
        }
        if (grants !== null) {
          await tx.userPermissionGrant.deleteMany({ where: { userId: id } })
          if (grants.length > 0) {
            await tx.userPermissionGrant.createMany({
              data: grants.map((g) => ({ ...g, userId: id, grantedBy: me.userId })),
              skipDuplicates: true,
            })
          }
        }
        await assertAdminSurvives(tx as never, `修改「${target.name}」的权限`)
        await invalidateTokens(tx as never, [id])
      })

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'UPDATE', resource: 'user_permission', resourceId: id,
        detail:
          `修改「${target.name}」(${target.email}) 的权限：` +
          (roleIds ? `角色 ${roleIds.length} 个；` : '') +
          (grants ? `个人例外 ${grants.filter((g) => g.granted).length} 加 / ${grants.filter((g) => !g.granted).length} 减；` : '') +
          '已要求其重新登录',
      })

      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof RbacError) return NextResponse.json({ error: e.message }, { status: e.status })
      console.error('[rbac] update user permissions failed', e)
      return NextResponse.json({ error: '修改用户权限失败' }, { status: 500 })
    }
  }, { require: 'system.rbac.manage' })
}
