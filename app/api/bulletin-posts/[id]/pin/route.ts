import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertInternalUser, canManageBulletin } from '@/lib/bulletin'

/** PATCH /api/bulletin-posts/[id]/pin — 置顶/取消置顶，仅 BOSS/OPERATOR */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    const denied = assertInternalUser(user)
    if (denied) return denied
    if (!canManageBulletin(user)) {
      return NextResponse.json({ error: '权限不足，仅 BOSS/OPERATOR 可置顶' }, { status: 403 })
    }

    try {
      const { id } = await params
      const body = await req.json()
      const pinned = Boolean(body.pinned)

      const post = await prisma.bulletinPost.findUnique({ where: { id } })
      if (!post) {
        return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
      }

      const updated = await prisma.bulletinPost.update({
        where: { id },
        data: pinned
          ? { pinned: true, pinnedAt: new Date(), pinnedByUserId: user.userId }
          : { pinned: false, pinnedAt: null, pinnedByUserId: null },
        include: {
          author: { select: { id: true, name: true, role: true } },
          pinnedBy: { select: { id: true, name: true } },
        },
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PATCH /api/bulletin-posts/[id]/pin]', error)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }
  })
}
