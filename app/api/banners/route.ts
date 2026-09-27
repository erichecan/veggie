import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { parseBusinessDate } from '@/lib/banner-dates'

/**
 * 客户门户首页轮播图管理（后台）
 *
 * GET  /api/banners  —— 全部轮播图（含未生效/已过期的，后台要能看到并编辑）
 * POST /api/banners  —— 新建一条
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const banners = await prisma.banner.findMany({ orderBy: { sequence: 'asc' } })
      return NextResponse.json(serializeApi(banners))
    } catch (error) {
      console.error('[GET /api/banners]', error)
      return NextResponse.json({ error: '获取轮播图失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const title = String(body.title ?? '').trim()
      const imageUrl = String(body.imageUrl ?? '').trim()
      if (!title || !imageUrl) {
        return NextResponse.json({ error: '标题和图片不能为空' }, { status: 400 })
      }

      const banner = await prisma.banner.create({
        data: {
          title,
          imageUrl,
          linkUrl: body.linkUrl ? String(body.linkUrl).trim() : null,
          productId: body.productId || null,
          sequence: Number.isFinite(body.sequence) ? body.sequence : 0,
          active: body.active !== false,
          dateStart: body.dateStart ? parseBusinessDate(body.dateStart) : null,
          dateEnd: body.dateEnd ? parseBusinessDate(body.dateEnd) : null,
        },
      })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'banner', resourceId: banner.id,
        detail: `新建轮播图: ${title}`,
      })
      return NextResponse.json(serializeApi(banner), { status: 201 })
    } catch (error) {
      console.error('[POST /api/banners]', error)
      return NextResponse.json({ error: '创建轮播图失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.create' })
}
