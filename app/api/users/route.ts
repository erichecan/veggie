import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

// GET /api/users — 用户列表（OPERATOR / BOSS / FINANCE）
export async function GET(req: Request) {
  return withAuth(req, async (me) => {
    try {
      const { searchParams } = new URL(req.url)
      const roleFilter = searchParams.get('role')?.toUpperCase()
      const users = await prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          roles: true,
          isActive: true,
          customerId: true,
          createdAt: true,
          updatedAt: true,
          // 上级：权限中心要显示这一列，也是「本人及下属」范围的判定依据
          managerId: true,
          manager: { select: { id: true, name: true } },
          // passwordHash 永远不返回给前端
        },
      })
      // 老数据 roles 为空时，回填一份 [role] 给前端，避免分散判断逻辑
      const normalized = users.map(u => ({
        ...u,
        roles: Array.isArray(u.roles) && u.roles.length > 0 ? u.roles : [String(u.role)],
      }))
      const filtered = roleFilter
        ? normalized.filter(u => u.roles.some(r => r.toUpperCase() === roleFilter))
        : normalized
      return NextResponse.json(serializeApi(filtered))
    } catch (error) {
      console.error('[GET /api/users]', error)
      return NextResponse.json({ error: '获取用户列表失败' }, { status: 500 })
    }
  }, { require: 'system.user.read' })
}

// POST /api/users — 新建用户（仅 OPERATOR）
export async function POST(req: Request) {
  return withAuth(req, async (me) => {
    try {
      const body = await req.json() as {
        name?: string; email?: string; password?: string;
        role?: string; roles?: string[];
      }
      const { name, email, password } = body

      if (!name?.toString().trim()) return NextResponse.json({ error: '姓名不能为空' }, { status: 400 })
      if (!email?.toString().trim()) return NextResponse.json({ error: '邮箱不能为空' }, { status: 400 })
      if (!password || String(password).length < 6) return NextResponse.json({ error: '密码至少 6 位' }, { status: 400 })

      // ⛔ 与 prisma enum Role 一致。这份白名单此前少了 EXTERNAL_SALES / DISPATCH / OTHER
      //    —— 8/6 加了角色但没回来更新，管理员因此建不出外部销售与调度账号。
      const VALID_ROLES = ['OPERATOR', 'RESTAURANT', 'PICKER', 'SORTER', 'DRIVER', 'BOSS', 'FINANCE', 'WAREHOUSE', 'SALES', 'EXTERNAL_SALES', 'DISPATCH', 'OTHER']

      // 入参可以传 role (单角色，旧客户端) 或 roles[] (新多角色)，至少有一个。
      // role 当作主角色；roles[] 至少包含 role。
      let primaryRole = body.role
      let rolesArr: string[] = Array.isArray(body.roles) ? body.roles.map(String) : []
      if (!primaryRole && rolesArr.length > 0) primaryRole = rolesArr[0]
      if (primaryRole && !rolesArr.includes(primaryRole)) rolesArr = [primaryRole, ...rolesArr]
      if (!primaryRole) {
        return NextResponse.json({ error: '必须指定 role 或 roles' }, { status: 400 })
      }
      const invalid = [primaryRole, ...rolesArr].find(r => !VALID_ROLES.includes(r))
      if (invalid) return NextResponse.json({ error: `无效角色: ${invalid}` }, { status: 400 })

      const existing = await prisma.user.findUnique({ where: { email: email.toString().trim().toLowerCase() } })
      if (existing) return NextResponse.json({ error: '该邮箱已被注册' }, { status: 409 })

      const passwordHash = await bcrypt.hash(String(password), 12)
      const user = await prisma.user.create({
        data: {
          name: String(name).trim().slice(0, 100),
          email: String(email).trim().toLowerCase().slice(0, 200),
          passwordHash,
          role: primaryRole as never,
          roles: rolesArr,
          isActive: true,
        },
        select: { id: true, email: true, name: true, role: true, roles: true, isActive: true, createdAt: true, updatedAt: true },
      })

      // ⛔ 必须建 UserRoleLink：权限判定的真相是它，不是 role/roles[]。
      // 漏了的话新账号登录后权限集为空 —— 人建出来了，却什么都点不动。
      const appRoles = await prisma.appRole.findMany({
        where: { code: { in: rolesArr.map((r) => r.toLowerCase()) } },
        select: { id: true },
      })
      if (appRoles.length > 0) {
        await prisma.userRoleLink.createMany({
          data: appRoles.map((r) => ({ userId: user.id, roleId: r.id })),
          skipDuplicates: true,
        })
      }

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'CREATE', resource: 'user', resourceId: user.id,
        detail: `创建用户 ${user.name}（${rolesArr.join('+')}）`,
      })

      return NextResponse.json(serializeApi(user), { status: 201 })
    } catch (error) {
      console.error('[POST /api/users]', error)
      return NextResponse.json({ error: '创建用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}
