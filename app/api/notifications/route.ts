import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

/**
 * P1-11: 通知系统
 *
 * GET   /api/notifications          — 当前用户的通知列表
 * POST  /api/notifications          — 创建通知（内部调用）
 * PATCH /api/notifications          — 批量标记已读
 */

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const url = new URL(req.url)
      const unreadOnly = url.searchParams.get('unreadOnly') === 'true'
      const type = url.searchParams.get('type')
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50))

      const where: Record<string, unknown> = { userId: user.userId }
      if (unreadOnly) where.read = false
      if (type) where.type = type

      const [items, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId: user.userId, read: false } }),
      ])

      return NextResponse.json(serializeApi({ items, total, unreadCount, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/notifications]', error)
      return NextResponse.json({ error: '获取通知失败' }, { status: 500 })
    }
  })
}

/**
 * POST /api/notifications — 创建通知
 *
 * 请求体：
 *   { userId, type, title, body, data? }
 *   或批量：{ notifications: [{ userId, type, title, body, data? }, ...] }
 *
 * 仅 OPERATOR/BOSS/WAREHOUSE 角色可调用
 */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const body = await req.json()

      // 支持单条和批量
      if (body.notifications && Array.isArray(body.notifications)) {
        // 批量创建
        const data = body.notifications.map((n: { userId: string; type: string; title: string; body: string; data?: unknown }) => ({
          userId: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          data: n.data ?? {},
        }))

        const result = await prisma.notification.createMany({ data })
        return NextResponse.json(serializeApi({ created: result.count }), { status: 201 })
      }

      // 单条创建
      const { userId, type, title, body: notifBody, data } = body
      if (!userId || !type || !title || !notifBody) {
        return NextResponse.json(
          { error: '缺少必填字段: userId, type, title, body' },
          { status: 400 },
        )
      }

      const notification = await prisma.notification.create({
        data: {
          userId,
          type,
          title,
          body: notifBody,
          data: data ?? {},
        },
      })

      return NextResponse.json(serializeApi(notification), { status: 201 })
    } catch (error) {
      console.error('[POST /api/notifications]', error)
      return NextResponse.json({ error: '创建通知失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}

/**
 * PATCH /api/notifications — 批量标记已读
 *
 * 请求体：
 *   { ids: string[] }        — 指定 ID 标记已读
 *   { markAllRead: true }    — 当前用户全部标记已读
 */
export async function PATCH(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()

      if (body.markAllRead) {
        const result = await prisma.notification.updateMany({
          where: { userId: user.userId, read: false },
          data: { read: true },
        })
        return NextResponse.json(serializeApi({ updated: result.count }))
      }

      if (body.ids && Array.isArray(body.ids) && body.ids.length > 0) {
        const result = await prisma.notification.updateMany({
          where: {
            id: { in: body.ids },
            userId: user.userId,  // 只能标记自己的通知
          },
          data: { read: true },
        })
        return NextResponse.json(serializeApi({ updated: result.count }))
      }

      return NextResponse.json({ error: '请提供 ids 数组或 markAllRead: true' }, { status: 400 })
    } catch (error) {
      console.error('[PATCH /api/notifications]', error)
      return NextResponse.json({ error: '更新通知失败' }, { status: 500 })
    }
  })
}
