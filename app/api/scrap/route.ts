import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { consumeLotsFIFO } from '@/lib/inventory'
import { SCRAP_REASONS, SCRAP_REASON_LABEL as REASON_LABEL } from '@/lib/scrap-reasons'
import { LOSS_STAGE_LABEL, isLossStage, type LossStage } from '@/lib/loss-attribution'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const moves = await p.stockMove.findMany({
      where: { type: 'SCRAP' },
      orderBy: { movedAt: 'desc' },
      take: limit,
      include: {
        lot: { select: { lotNumber: true, arrivedAt: true, sourceRef: true } },
      },
    })
    return NextResponse.json(serializeApi(moves))
  } catch (error) {
    console.error('[GET /api/scrap]', error)
    return NextResponse.json({ error: '获取报废记录失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      const productId = data.productId?.toString().trim()
      const productName = data.productName?.toString().trim().slice(0, 200)
      const qty = Number(data.qty)
      const reason = data.reason?.toString().trim() ?? ''
      const notes = data.notes?.toString().trim().slice(0, 500) ?? ''
      const lotId = data.lotId?.toString().trim() || null
      // 损耗环节（台账 E4）：分拣/运输/仓储… 与「原因」正交 —— 同样是损坏，
      // 收货时发现是供应商责任，分拣时发生是自家操作，混一个枚举就再也分不开
      const stageRaw = data.stage?.toString().trim() ?? ''
      const stage: LossStage | null = isLossStage(stageRaw) ? stageRaw : null

      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })
      if (stageRaw && !stage) {
        return NextResponse.json({ error: `无效的损耗环节: ${stageRaw}` }, { status: 400 })
      }
      if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) {
        return NextResponse.json({ error: '报废数量必须大于 0 且不超过 100,000' }, { status: 400 })
      }
      if (reason && !SCRAP_REASONS.includes(reason as typeof SCRAP_REASONS[number])) {
        return NextResponse.json({ error: `无效的报废原因: ${reason}` }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const product = await p.product.findUnique({
        where: { id: productId },
        include: { template: { select: { type: true } } },
      })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })
      if (product.template?.type !== 'PRODUCT') {
        return NextResponse.json({ error: '只有实物商品可以报废' }, { status: 400 })
      }

      const onHand = toNum(product.qtyOnHand)
      if (onHand < qty) {
        return NextResponse.json({
          error: `库存不足，当前库存 ${onHand}，报废数量 ${qty}`,
        }, { status: 409 })
      }

      // 如果指定了批次，校验批次归属和余量
      let lotNumber: string | null = null
      if (lotId) {
        const lot = await p.lot.findUnique({ where: { id: lotId } })
        if (!lot) return NextResponse.json({ error: '批次不存在' }, { status: 404 })
        if (lot.productId !== productId) {
          return NextResponse.json({ error: '批次与商品不匹配' }, { status: 400 })
        }
        if (toNum(lot.currentQty) < qty) {
          return NextResponse.json({
            error: `批次 ${lot.lotNumber} 剩余 ${toNum(lot.currentQty)}，不足报废 ${qty}`,
          }, { status: 409 })
        }
        lotNumber = lot.lotNumber
      }

      // Generate scrap reference
      const scrapCount = await p.stockMove.count({ where: { type: 'SCRAP' } })
      const scrapRef = `SCRAP-${String(scrapCount + 1).padStart(5, '0')}`

      const reasonLabel = REASON_LABEL[reason] ?? reason
      const stageLabel = stage ? LOSS_STAGE_LABEL[stage] : ''
      const lotLabel = lotNumber ? ` / 批次 ${lotNumber}` : ''
      // note 仍拼给人看；看板不再靠正则从这句话里反解 —— 它读结构化的 lossStage/lossReason
      const noteText = [stageLabel && `${stageLabel}环节`, reasonLabel, notes].filter(Boolean).join(' - ')

      // Atomic: decrement stock + update lot + create scrap move
      const result = await p.$transaction(async (tx: typeof p) => {
        await tx.product.update({
          where: { id: productId },
          data: { qtyOnHand: { decrement: qty } },
        })

        // 扣减批次余量：指定了批次就扣那一批，否则按 FIFO 扣最早批次，保持 Lot 与 qtyOnHand 同步
        if (lotId) {
          const updatedLot = await tx.lot.update({
            where: { id: lotId },
            data: { currentQty: { decrement: qty } },
          })
          // 耗尽则标记 DEPLETED
          if (toNum(updatedLot.currentQty) <= 0) {
            await tx.lot.update({
              where: { id: lotId },
              data: { status: 'DEPLETED' },
            })
          }
        } else {
          await consumeLotsFIFO(tx, productId, qty)
        }

        const move = await tx.stockMove.create({
          data: {
            productId,
            productName: productName || product.name || '未知商品',
            type: 'SCRAP',
            qty: -qty,
            lotId,
            movedAt: new Date(),
            note: (noteText || `报废 ${scrapRef}`) + lotLabel,
            lossStage: stage,
            lossReason: reason || null,
            sourceType: 'SCRAP',
            sourceId: null,
            sourceRef: scrapRef,
          },
        })
        return move
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'scrap', resourceId: result.id,
        detail: `报废 ${scrapRef}: ${productName ?? product.name} x${qty} (${[stageLabel, reasonLabel].filter(Boolean).join(' / ')})${lotLabel}`,
      })

      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      console.error('[POST /api/scrap]', error)
      return NextResponse.json({ error: '创建报废记录失败' }, { status: 500 })
    }
  }, { require: 'stock.scrap.manage' })
}
