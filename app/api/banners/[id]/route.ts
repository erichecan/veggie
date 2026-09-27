import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { parseBusinessDate } from '@/lib/banner-dates'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const title = String(body.title ?? '').trim()
      const imageUrl = String(body.imageUrl ?? '').trim()
      if (!title || !imageUrl) {
        return NextResponse.json({ error: '标题和图片不能为空' }, { status: 400 })
      }

      const banner = await prisma.banner.update({
        where: { id },
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
        action: 'UPDATE', resource: 'banner', resourceId: banner.id,
        detail: `编辑轮播图: ${title}`,
      })
      return NextResponse.json(serializeApi(banner))
    } catch (error) {
      console.error('[PUT /api/banners/[id]]', error)
      return NextResponse.json({ error: '更新轮播图失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const banner = await prisma.banner.delete({ where: { id } })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'banner', resourceId: id,
        detail: `删除轮播图: ${banner.title}`,
      })
      return NextResponse.json({ success: true })
    } catch (error) {
      console.error('[DELETE /api/banners/[id]]', error)
      return NextResponse.json({ error: '删除轮播图失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.delete' })
}
