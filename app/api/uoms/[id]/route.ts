import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * PUT /api/uoms/[id]
 * ============================================================================
 * 编辑 UoM。白名单允许的字段：name / nameZh / goodsType / active
 * - goodsType 限定 BULK / LOOSE / null
 * - 20260823 起不再接受 factor / rounding：换算系数改挂商品（ProductSaleUom.factor），
 *   单位本身只剩名称与货物类型。DB 列仍在（分析 SQL 等处仍读），只是不再从这里改。
 * - 不允许直接改 categoryId（迁移单位会破坏已有商品换算）
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const update: Record<string, any> = {}

      if (body.name !== undefined) {
        const n = String(body.name).trim()
        if (!n) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
        update.name = n
      }
      if (body.nameZh !== undefined) {
        update.nameZh = body.nameZh ? String(body.nameZh).trim() : null
      }
      if (body.goodsType !== undefined) {
        const g = body.goodsType
        update.goodsType =
          g === 'BULK' ? 'BULK' :
          g === 'LOOSE' ? 'LOOSE' :
          (g === null || g === '') ? null :
          undefined
        if (update.goodsType === undefined) {
          return NextResponse.json({ error: 'goodsType 必须是 BULK / LOOSE / null' }, { status: 400 })
        }
      }
      if (body.active !== undefined) {
        update.active = Boolean(body.active)
      }

      if (Object.keys(update).length === 0) {
        return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const updated = await p.uom.update({ where: { id }, data: update })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'uom', resourceId: id,
        detail: `更新 UoM: ${updated.name}（${Object.keys(update).join(', ')}）`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/uoms/[id]]', error)
      return NextResponse.json({ error: '更新 UoM 失败' }, { status: 500 })
    }
  }, { require: 'master.uom.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      await p.uom.update({ where: { id }, data: { active: false } })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'uom', resourceId: id,
        detail: `停用 UoM: ${id}`,
      })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/uoms/[id]]', error)
      return NextResponse.json({ error: '停用 UoM 失败' }, { status: 500 })
    }
  }, { require: 'master.uom.update' })
}
