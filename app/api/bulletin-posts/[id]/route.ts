import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { assertInternalUser, canManageBulletin } from '@/lib/bulletin'

/** DELETE /api/bulletin-posts/[id] — 本人删自己的帖子，BOSS/OPERATOR 可删任意帖 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    const denied = assertInternalUser(user)
    if (denied) return denied

    try {
      const { id } = await params
      const post = await prisma.bulletinPost.findUnique({ where: { id } })
      if (!post) {
        return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
      }

      const isOwner = post.authorId === user.userId
      if (!isOwner && !canManageBulletin(user)) {
        return NextResponse.json({ error: '只能删除自己发布的帖子' }, { status: 403 })
      }

      await prisma.bulletinPost.delete({ where: { id } })
      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('[DELETE /api/bulletin-posts/[id]]', error)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }
  })
}
