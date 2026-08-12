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

        // 扣减批次余量：指定了批次就扣那一批，否则按 FIFO 扣最早批次，保持 Lot 与 qtyOnHand 同步。
        // ⚠️ FIFO 分支下**流水的 lotId 是 null**，而批次余量被扣了 —— 这会破坏
        // 「Lot.currentQty == Σ该批次流水」（F3 周期在采购退货上撞到同一个形态）。
        // 这里的商品若有批次就会中招；之所以一直没暴露，是因为报废测试用的商品
        // 都是没有批次的期初库存。fifoConsumed 收集实际扣到的批次，下面据此补记流水。
        let fifoConsumed: Array<{ lotId: string; lotNumber: string; qty: number }> = []
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
          fifoConsumed = await consumeLotsFIFO(tx, productId, qty)
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
        // FIFO 扣了哪几个批次，就把那部分金额从总流水里拆出来挂到批次上，
        // 使「Lot.currentQty == Σ该批次流水」重新成立（总量不变，只是拆分记账）
        if (fifoConsumed.length > 0) {
          const covered = fifoConsumed.reduce((s2, c) => s2 + c.qty, 0)
          for (const c of fifoConsumed) {
            await tx.stockMove.create({
              data: {
                productId,
                productName: productName || product.name || '未知商品',
                type: 'SCRAP',
                qty: -c.qty,
                lotId: c.lotId,
                movedAt: new Date(),
                note: `${noteText || `报废 ${scrapRef}`} / 批次 ${c.lotNumber}`,
                sourceType: 'SCRAP',
                sourceRef: scrapRef,
              },
            })
          }
          // 主流水只保留没落到批次上的那部分；全部落到批次时把它清成 0 会更干净，
          // 但删掉又会丢失「这次报废」的主记录，所以改写数量、保留记录
          await tx.stockMove.update({
            where: { id: move.id },
            data: { qty: -(Math.round((qty - covered) * 1000) / 1000) },
          })
        }

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
