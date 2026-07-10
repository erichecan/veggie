import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

/**
 * PATCH /api/products/[id]/zone
 * 更新商品实际所在温区（Product.currentZoneId），用于仓库地图页"温区不符"表的移货确认操作。
 *
 * 请求体（二选一）：
 *   { zoneId: string }        — 显式指定目标温区 id
 *   { useRequiredZone: true } — 使用该商品所属类目的 requiredZoneId 作为目标温区（常见场景：仓库员按业务规则把货物移到正确温区后确认）
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      const product = await prisma.product.findUnique({
        where: { id },
        include: {
          currentZone: { select: { id: true, nameZh: true } },
          category: { select: { requiredZoneId: true, requiredZone: { select: { id: true, nameZh: true } } } },
        },
      })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      let targetZoneId: string | null = null
      if (data.useRequiredZone === true) {
        targetZoneId = product.category?.requiredZoneId ?? null
        if (!targetZoneId) {
          return NextResponse.json({ error: '该商品所属类目未设置业务应放温区，请显式指定 zoneId' }, { status: 400 })
        }
      } else {
        targetZoneId = data.zoneId?.toString().trim() || null
        if (!targetZoneId) return NextResponse.json({ error: 'zoneId 不能为空' }, { status: 400 })
      }

      const targetZone = await prisma.zone.findUnique({ where: { id: targetZoneId } })
      if (!targetZone) return NextResponse.json({ error: '目标温区不存在' }, { status: 404 })

      const beforeZoneId = product.currentZoneId
      const beforeZoneNameZh = product.currentZone?.nameZh ?? '未定位'

      const updated = await prisma.product.update({
        where: { id },
        data: { currentZoneId: targetZoneId },
        include: { currentZone: { select: { nameZh: true } } },
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name ?? user.email,
        action: 'UPDATE',
        resource: 'product_zone',
        resourceId: id,
        detail: `商品「${product.name}」温区: ${beforeZoneNameZh} → ${updated.currentZone?.nameZh ?? '未定位'}`,
        changes: {
          currentZoneId: { before: beforeZoneId, after: targetZoneId },
        },
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PATCH /api/products/[id]/zone]', error)
      return NextResponse.json({ error: '更新商品温区失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
