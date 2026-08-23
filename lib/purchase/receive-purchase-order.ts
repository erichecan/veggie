import { NextResponse } from 'next/server'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'

/**
 * 采购「确认收货」——全系统唯一真正改库存的采购侧动作(20260823 从库存收货台
 * `POST /api/goods-receipts` 搬入；那边现在只负责记录到货，不再碰库存)。
 *
 * 数量口径(DEV-PLAN 决策#2)：默认按各行 orderedQty，请求体可用 lines 按行覆盖成实收数量。
 * 库存/批次/加权平均成本的写法照搬原 goods-receipts 良品分支，一字不改，
 * 避免"两处各留一份、以后改一处漏一处"(风险#1)。
 */

interface ReceiveLineInput { lineId?: unknown; qty?: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleReceiveAction(p: any, po: any, poId: string, user: { userId: string; email: string; name: string }, body: unknown) {
  if (po.status !== 'CONFIRMED') {
    return NextResponse.json({ error: `PO 状态 ${po.status}，无法确认收货（需 CONFIRMED）` }, { status: 409 })
  }

  const rawLines: ReceiveLineInput[] = Array.isArray((body as { lines?: unknown })?.lines)
    ? (body as { lines: ReceiveLineInput[] }).lines
    : []
  const overrideMap = new Map(rawLines.map(l => [String(l.lineId ?? ''), l.qty]))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planned: Array<{ line: any; qty: number }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const line of po.lines as any[]) {
    const override = overrideMap.has(line.id) ? Number(overrideMap.get(line.id)) : null
    const qty = override !== null && Number.isFinite(override) ? override : toNum(line.orderedQty)
    if (qty < 0) {
      return NextResponse.json({ error: `确认数量不能为负数：${line.productName}` }, { status: 400 })
    }
    planned.push({ line, qty })
  }

  const receivedAt = new Date()
  const batchDate: Date = po.expectedDate ?? receivedAt

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await p.$transaction(async (tx: any) => {
    let lotSeq = await tx.lot.count()

    for (const { line, qty } of planned) {
      if (qty <= 0) continue

      // 单位换算：确认数量是采购单位，qtyOnHand/StockMove/Lot 一律基准单位计（同 I3 修的坑）
      const stockQty = await toStockQty(tx, line.productId, qty, line.uomId ?? null)
      const ratio = qty !== 0 ? stockQty / qty : 1

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty: { increment: qty } },
      })

      // SSOT(成本): 收货按加权平均回写 standardPrice；单价与数量同步换算到基准单位，
      // 否则「60 包」按「每包 €20」计入加权，成本虚高 12 倍
      const recvCost = Number(line.unitCostEur ?? 0)
      const costPerBase = ratio !== 0 ? recvCost / ratio : recvCost
      const prod = await tx.product.findUnique({ where: { id: line.productId }, select: { qtyOnHand: true, standardPrice: true } })
      const oldQty = Math.max(Number(prod?.qtyOnHand ?? 0), 0)
      const oldStd = Number(prod?.standardPrice ?? 0)
      const newStd = costPerBase > 0 && (oldQty + stockQty) > 0
        ? Math.round(((oldQty * oldStd + stockQty * costPerBase) / (oldQty + stockQty)) * 100) / 100
        : oldStd
      await tx.product.update({
        where: { id: line.productId },
        data: { qtyOnHand: { increment: stockQty }, ...(newStd !== oldStd ? { standardPrice: newStd } : {}) },
      })

      lotSeq++
      const lotNumber = `LOT-${String(lotSeq).padStart(5, '0')}`
      const lot = await tx.lot.create({
        data: {
          lotNumber,
          productId: line.productId,
          initialQty: stockQty,
          currentQty: stockQty,
          // 不再叫 GOODS_RECEIPT：那个值意味着 sourceId 指向一张 GoodsReceipt，
          // 而现在的 sourceId 是 PO id —— 沿用旧值会让 lots/trace 的质检回查查错表
          sourceType: 'PURCHASE_RECEIVE',
          sourceId: poId,
          sourceRef: po.name,
          bestBefore: line.bestBefore ?? null,
          arrivedAt: batchDate,
          unitCost: costPerBase > 0 ? costPerBase : null,
        },
      })

      await tx.stockMove.create({
        data: {
          productId: line.productId,
          productName: line.productName,
          type: 'IN',
          qty: stockQty,
          lotId: lot.id,
          movedAt: batchDate,
          note: `采购确认收货 PO ${po.name} / 批次 ${lotNumber}`,
          sourceType: 'PURCHASE_RECEIVE',
          sourceId: poId,
          sourceRef: po.name,
        },
      })
    }

    // 全量到货才把 PO 推到 RECEIVED；否则维持 CONFIRMED，允许后续再确认剩余数量（分批）
    const updatedLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allReceived = updatedLines.every((l: any) => toNum(l.receivedQty) >= toNum(l.orderedQty))
    const updated = await tx.purchaseOrder.update({
      where: { id: poId },
      data: allReceived ? { status: 'RECEIVED' as const } : {},
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    return updated
  })

  const receivedDetail = planned.filter(x => x.qty > 0).map(x => `${x.line.productName} ×${x.qty}`).join('、')
  await writeLog({
    userId: user.userId, userEmail: user.email, userName: user.name,
    action: 'UPDATE', resource: 'purchase_order', resourceId: poId,
    detail: `确认收货 PO ${po.name}${receivedDetail ? `：${receivedDetail}` : '（本次无入库数量）'}`,
  })

  return NextResponse.json(serializeApi(result))
}
