import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertInternalUser, BULLETIN_CATEGORIES, type BulletinCategoryValue } from '@/lib/bulletin'

/**
 * 信息广场
 *
 * GET  /api/bulletin-posts  — 列表，支持 ?category= ?q= ?page= ?pageSize=，置顶帖始终排最前
 * POST /api/bulletin-posts  — 发帖，所有内部登录用户可用
 */

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    const denied = assertInternalUser(user)
    if (denied) return denied

    try {
      const url = new URL(req.url)
      const category = url.searchParams.get('category')
      const q = url.searchParams.get('q')?.trim()
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))

      const where: Record<string, unknown> = {}
      if (category && (BULLETIN_CATEGORIES as readonly string[]).includes(category)) {
        where.category = category
      }
      if (q) {
        where.content = { contains: q, mode: 'insensitive' }
      }

      const [items, total] = await Promise.all([
        prisma.bulletinPost.findMany({
          where,
          orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            author: { select: { id: true, name: true, role: true } },
            pinnedBy: { select: { id: true, name: true } },
          },
        }),
        prisma.bulletinPost.count({ where }),
      ])

      return NextResponse.json(serializeApi({ items, total, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/bulletin-posts]', error)
      return NextResponse.json({ error: '获取信息广场失败' }, { status: 500 })
    }
  })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    const denied = assertInternalUser(user)
    if (denied) return denied

    try {
      const body = await req.json()
      const { category, content, imageUrl } = body as {
        category?: string
        content?: string
        imageUrl?: string | null
      }

      if (!category || !(BULLETIN_CATEGORIES as readonly string[]).includes(category)) {
        return NextResponse.json({ error: '分类不合法' }, { status: 400 })
      }
      const trimmed = typeof content === 'string' ? content.trim() : ''
      if (!trimmed) {
        return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
      }

      const post = await prisma.bulletinPost.create({
        data: {
          category: category as BulletinCategoryValue,
          content: trimmed,
          imageUrl: imageUrl || null,
          authorId: user.userId,
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
      })

      return NextResponse.json(serializeApi(post), { status: 201 })
    } catch (error) {
      console.error('[POST /api/bulletin-posts]', error)
      return NextResponse.json({ error: '发布失败' }, { status: 500 })
    }
  })
}
