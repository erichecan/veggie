import { NextResponse } from 'next/server'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'
import { nextLotNumbers } from '@/lib/lot-number'
import { postStockMove, LOC } from '@/lib/stock-ledger'

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
  const allowOverReceipt = (body as { allowOverReceipt?: unknown })?.allowOverReceipt === true

  // 实际到货日期由输单的人手动填（默认今天，可改）——不能用点「确认收货」这一刻的
  // 系统时间：仓库可能隔一天才有空登记，那样台账 E7 准时率和批次到货日都会记错一天(20261020)
  const arrivedAtRaw = (body as { arrivedAt?: unknown })?.arrivedAt
  let receivedAt = new Date()
  if (arrivedAtRaw != null && arrivedAtRaw !== '') {
    const parsed = new Date(String(arrivedAtRaw))
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: '到货日期无效' }, { status: 400 })
    }
    receivedAt = parsed
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planned: Array<{ line: any; qty: number }> = []
  const over: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const line of po.lines as any[]) {
    const ordered = toNum(line.orderedQty)
    const already = toNum(line.receivedQty)
    // 默认收「剩余未收」而不是整行下单量（20261020）：分批收货第二次点确认时，
    // 原来默认又按整行数量入库，已收 30/50 再收就成了 80
    const remaining = Math.max(0, Math.round((ordered - already) * 1000) / 1000)
    const override = overrideMap.has(line.id) ? Number(overrideMap.get(line.id)) : null
    const qty = override !== null && Number.isFinite(override) ? override : remaining
    if (qty < 0) {
      return NextResponse.json({ error: `确认数量不能为负数：${line.productName}` }, { status: 400 })
    }
    const after = already + qty
    if (after - ordered > 0.0005) {
      over.push(`${line.productName} 收货后 ${Math.round(after * 1000) / 1000}，订购 ${ordered}（多 ${Math.round((after - ordered) * 1000) / 1000}）`)
    }
    planned.push({ line, qty })
  }
  // 超收要明确确认（20261020 客户录屏：订购 50 箱，确认数量手滑成 500，系统一声不吭收了 500 箱、
  // 库存和应付暂估都多了 10 倍）。真的多到了货（供应商多发）也允许，但得显式带 allowOverReceipt
  if (over.length > 0 && !allowOverReceipt) {
    return NextResponse.json({
      error: `收货数量超出订购数量：${over.join('；')}。如确实多到货，请确认后再提交`,
      code: 'OVER_RECEIPT',
      overLines: over,
    }, { status: 409 })
  }

  const batchDate: Date = po.expectedDate ?? receivedAt

  // firstArrivedAt/lastArrivedAt(台账 E7 准时率用)原本只由单独的「到货登记」工作台
  // （POST /api/goods-receipts）回写；但仓库大多数时候直接在这里点「确认收货」，从不走
  // 那个台账，导致这两个字段对大多数采购单一直是 null，准时率分析悄悄漏掉这些单(20261015)。
  // 这里兜底补上——但只在没人做过到货登记时才写，避免盖掉更准的、仓库实际记录的到货时间。
  const hasGoodsReceipt = (await p.goodsReceipt.count({ where: { purchaseOrderId: poId } })) > 0

  let result
  try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result = await p.$transaction(async (tx: any) => {
    // 批次号取现有最大号往后排(lib/lot-number.ts)；不能用 count+1，有空号/自定义批次号就撞号
    const lotNumbers = await nextLotNumbers(tx, planned.filter(x => x.qty > 0).length)
    let lotIdx = 0

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
      // 20261017 运费分摊成本联动：confirm 时已把分摊运费算进 landedUnitCostEur 并推到
      // standardPrice；若还用不含运费的 unitCostEur 做加权基数，首次收货（oldQty=0）算出来的
      // newStd 会精确退化回 unitCostEur，把 confirm 刚写的运费成本悄悄冲掉——两步操作是采购单
      // 正常流程的下一步，不是边缘情况。有落地成本就用落地成本做加权基数，没有（老单/SERVICE 行）
      // 才退回 unitCostEur（code-review 发现，20261017 补）。
      const recvCost = Number(line.landedUnitCostEur ?? line.unitCostEur ?? 0)
      const costPerBase = ratio !== 0 ? recvCost / ratio : recvCost
      const prod = await tx.product.findUnique({ where: { id: line.productId }, select: { qtyOnHand: true, standardPrice: true } })
      const oldQty = Math.max(Number(prod?.qtyOnHand ?? 0), 0)
      const oldStd = Number(prod?.standardPrice ?? 0)
      const newStd = costPerBase > 0 && (oldQty + stockQty) > 0
        ? Math.round(((oldQty * oldStd + stockQty * costPerBase) / (oldQty + stockQty)) * 100) / 100
        : oldStd
      if (newStd !== oldStd) {
        await tx.product.update({ where: { id: line.productId }, data: { standardPrice: newStd } })
      }

      const lotNumber = lotNumbers[lotIdx++]
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

      // 入账：供应商 → 仓库（lib/stock-ledger.ts）。批次余量建批次时已设好，这里只挂 lotId；
      // 按采购价估值，出凭证 Dr 1300 存货 / Cr 2150 已收货未开票
      await postStockMove(tx, {
        productId: line.productId,
        productName: line.productName,
        qty: stockQty,
        from: LOC.VENDORS,
        to: LOC.STOCK,
        type: 'IN',
        lot: { mode: 'lot', lotId: lot.id, adjustLot: false },
        unitCost: costPerBase > 0 ? costPerBase : null,
        movedAt: batchDate,
        note: `采购确认收货 PO ${po.name} / 批次 ${lotNumber}`,
        sourceType: 'PURCHASE_RECEIVE',
        sourceId: poId,
        sourceRef: po.name,
        purchaseOrderLineId: line.id,
        partnerId: po.supplierId ?? null,
        uomQty: qty,
        uomId: line.uomId ?? null,
        userId: user.userId,
        createdBy: user.name ?? user.email,
      })
    }

    // 全量到货才把 PO 推到 RECEIVED；否则维持 CONFIRMED，允许后续再确认剩余数量（分批）
    const updatedLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allReceived = updatedLines.every((l: any) => toNum(l.receivedQty) >= toNum(l.orderedQty))
    const updated = await tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        ...(allReceived ? { status: 'RECEIVED' as const } : {}),
        ...(hasGoodsReceipt ? {} : { firstArrivedAt: po.firstArrivedAt ?? receivedAt, lastArrivedAt: receivedAt }),
      },
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    return updated
  }, { maxWait: 10000, timeout: 30000 })
  } catch (e) {
    // 把真实原因带回界面，不再只剩一句 "Server temporarily unavailable"
    const code = (e as { code?: string })?.code
    console.error('[receive purchase order]', poId, e)
    if (code === 'P2002') {
      return NextResponse.json({ error: '批次号冲突，请重试一次；仍失败请联系管理员' }, { status: 409 })
    }
    if (code === 'P2028') {
      return NextResponse.json({ error: '收货处理超时，请稍后重试' }, { status: 503 })
    }
    throw e
  }

  const receivedDetail = planned.filter(x => x.qty > 0).map(x => `${x.line.productName} ×${x.qty}`).join('、')
  await writeLog({
    userId: user.userId, userEmail: user.email, userName: user.name,
    action: 'UPDATE', resource: 'purchase_order', resourceId: poId,
    detail: `确认收货 PO ${po.name}${receivedDetail ? `：${receivedDetail}` : '（本次无入库数量）'}${over.length ? `；⚠️ 超收已确认：${over.join('；')}` : ''}`,
  })

  return NextResponse.json(serializeApi(result))
}
