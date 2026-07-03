import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { toNum } from '@/lib/decimal-helpers'

/**
 * /api/stock-takes/[id]
 * ============================================================================
 * GET    详情（含行）
 * PATCH  { action: 'save_counts', counts: [{ lineId, countedQty|null }] }  录入实盘（仅 DRAFT）
 *        { action: 'complete' }  完成：对已录入且 diff ≠ 0 的行生成
 *          StockMove(ADJUSTMENT, sourceType='STOCK_TAKE') 并同步 Product.qtyOnHand；
 *          未录入实盘的行视为未盘（diffQty 保持 null，不调整）
 *        { action: 'cancel' }    取消（仅 DRAFT）
 */

const STOCK_TAKE_ROLES = ['OPERATOR', 'WAREHOUSE', 'BOSS']

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const st = await p.stockTake.findUnique({
        where: { id },
        include: { lines: { orderBy: { productName: 'asc' } } },
      })
      if (!st) return NextResponse.json({ error: '盘点单不存在' }, { status: 404 })
      return NextResponse.json(serializeApi(st))
    } catch (error) {
      console.error('[GET /api/stock-takes/:id]', error)
      return NextResponse.json({ error: '获取盘点单失败' }, { status: 500 })
    }
  }, STOCK_TAKE_ROLES)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      const action = String(data.action ?? '')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const st = await p.stockTake.findUnique({ where: { id }, include: { lines: true } })
      if (!st) return NextResponse.json({ error: '盘点单不存在' }, { status: 404 })

      if (action === 'save_counts') {
        if (st.status !== 'DRAFT') {
          return NextResponse.json({ error: `盘点单状态 ${st.status}，不可修改` }, { status: 409 })
        }
        const counts: Array<{ lineId: string; countedQty: number | null }> =
          Array.isArray(data.counts) ? data.counts : []
        const lineIds = new Set(st.lines.map((l: { id: string }) => l.id))
        const valid = counts.filter((c) => lineIds.has(c.lineId))
        await p.$transaction(
          valid.map((c) =>
            p.stockTakeLine.update({
              where: { id: c.lineId },
              data: {
                countedQty:
                  c.countedQty === null || c.countedQty === undefined || Number.isNaN(Number(c.countedQty))
                    ? null
                    : Number(c.countedQty),
              },
            }),
          ),
        )
        const updated = await p.stockTake.findUnique({
          where: { id },
          include: { lines: { orderBy: { productName: 'asc' } } },
        })
        return NextResponse.json(serializeApi(updated))
      }

      if (action === 'complete') {
        if (st.status !== 'DRAFT') {
          return NextResponse.json({ error: `盘点单状态 ${st.status}，不可完成` }, { status: 409 })
        }
        const counted = st.lines.filter(
          (l: { countedQty: unknown }) => l.countedQty !== null && l.countedQty !== undefined,
        )
        if (counted.length === 0) {
          return NextResponse.json({ error: '尚未录入任何实盘数量' }, { status: 400 })
        }

        let adjustedLines = 0
        await p.$transaction(async (tx: typeof p) => {
          for (const line of counted) {
            const diff = Math.round((toNum(line.countedQty) - toNum(line.systemQty)) * 1000) / 1000
            await tx.stockTakeLine.update({
              where: { id: line.id },
              data: { diffQty: diff },
            })
            if (diff !== 0) {
              adjustedLines++
              await tx.stockMove.create({
                data: {
                  productId: line.productId,
                  productName: line.productName,
                  type: 'ADJUSTMENT',
                  qty: diff,
                  movedAt: st.takenAt,
                  note: `盘点 ${st.name}：系统 ${toNum(line.systemQty)} → 实盘 ${toNum(line.countedQty)}`,
                  sourceType: 'STOCK_TAKE',
                  sourceId: st.id,
                  sourceRef: st.name,
                },
              })
              await tx.product.update({
                where: { id: line.productId },
                data: { qtyOnHand: { increment: diff } },
              })
            }
          }
          await tx.stockTake.update({ where: { id }, data: { status: 'DONE' } })
        })

        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'stock_take', resourceId: id,
          detail: `${st.name} 完成盘点：${counted.length} 行已盘，${adjustedLines} 行有差异并已调整库存`,
        })
        const updated = await p.stockTake.findUnique({
          where: { id },
          include: { lines: { orderBy: { productName: 'asc' } } },
        })
        return NextResponse.json(serializeApi(updated))
      }

      if (action === 'cancel') {
        if (st.status !== 'DRAFT') {
          return NextResponse.json({ error: `盘点单状态 ${st.status}，不可取消` }, { status: 409 })
        }
        await p.stockTake.update({ where: { id }, data: { status: 'CANCELLED' } })
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'stock_take', resourceId: id,
          detail: `${st.name} 取消盘点`,
        })
        return NextResponse.json({ ok: true })
      }

      return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 })
    } catch (error) {
      console.error('[PATCH /api/stock-takes/:id]', error)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }
  }, STOCK_TAKE_ROLES)
}
