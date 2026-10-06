import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { createUserAccount } from '@/lib/user-account'

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
          userNo: true,
          email: true,
          name: true,
          role: true,
          roles: true,
          isActive: true,
          pendingApproval: true,
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
      const body = await req.json()
      // 校验与落库逻辑在 lib/user-account.ts，与批量导入 POST /api/users/bulk 共用同一份
      const result = await createUserAccount(body)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      const { user, roles } = result

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'CREATE', resource: 'user', resourceId: user.id,
        detail: `创建用户 ${user.name}（${roles.join('+')}）`,
      })

      return NextResponse.json(serializeApi(user), { status: 201 })
    } catch (error) {
      console.error('[POST /api/users]', error)
      return NextResponse.json({ error: '创建用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}
