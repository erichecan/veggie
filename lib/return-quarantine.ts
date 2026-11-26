import type { Prisma } from '@/lib/generated/prisma/client'
import { toNum } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'
import { LOC, postStockMove } from '@/lib/stock-ledger'
import { returnError } from '@/lib/return-invoice-guard'

type Tx = Prisma.TransactionClient
type Actor = { userId: string; name?: string | null; email: string }
type ReturnWithOrder = Prisma.OrderReturnGetPayload<{ include: { order: true; orderLine: true } }>

export function receivedReturnQuantity(ret: Pick<ReturnWithOrder, 'productId' | 'actualReturnedProductId' | 'actualReturnedStockQuantity' | 'warehouseAcceptedQuantity'>) {
  return toNum(ret.actualReturnedProductId && ret.actualReturnedProductId !== ret.productId ? ret.actualReturnedStockQuantity : ret.warehouseAcceptedQuantity)
}

function returnStockDetails(ret: ReturnWithOrder, actor: Actor) {
  const productId = ret.actualReturnedProductId ?? ret.productId
  return {
    productId, productName: ret.actualReturnedProductName ?? ret.productName,
    sourceId: ret.id, sourceRef: ret.order.code, userId: actor.userId, createdBy: actor.name ?? actor.email,
    uomId: productId === ret.productId ? ret.orderLine?.uomId ?? null : null,
  }
}

async function ensureValuation(tx: Tx, sourceId: string, sourceType: string) {
  const rows = await tx.stockMove.findMany({ where: { sourceId, sourceType }, select: { id: true, value: true } })
  if (rows.some(row => toNum(row.value) > 0.005)) {
    const journal = await tx.journalEntry.findFirst({ where: { sourceType: 'stock_move', sourceId: { in: rows.map(row => row.id) }, status: 'POSTED' }, select: { id: true } })
    if (!journal) returnError('库存估值科目未配置，库存流水未生效')
  }
}

export async function receiveReturnIntoQuarantine(tx: Tx, id: string, actor: Actor) {
  const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id }, include: { order: true, orderLine: true } })
  return receiveQuarantine(tx, ret, actor)
}

async function receiveQuarantine(tx: Tx, ret: ReturnWithOrder, actor: Actor) {
  const sourceType = 'ORDER_RETURN_QUARANTINE'
  const existing = await tx.stockMove.findFirst({ where: { sourceId: ret.id, sourceType }, select: { physicalQty: true, unitCost: true } })
  if (existing) return existing
  const details = returnStockDetails(ret, actor)
  const uomQty = receivedReturnQuantity(ret)
  if (!(uomQty > 0)) returnError('实际退回商品缺少有效数量')
  const qty = await toStockQty(tx, details.productId, uomQty, details.uomId)
  if (!(qty > 0)) returnError('退回商品换算后没有有效库存数量')
  const moves = await postStockMove(tx, {
    ...details, qty, uomQty, from: LOC.CUSTOMERS, to: LOC.RETURN_QUARANTINE, type: 'RETURN',
    sourceType, partnerId: ret.order.restaurantId, note: ret.warehouseNote,
  })
  await ensureValuation(tx, ret.id, sourceType)
  return moves.length ? { physicalQty: qty, unitCost: moves[0].unitCost } : null
}

/** Requires the source order lock. A legacy stock posting already disposed the entire return. */
export async function disposeQuarantinedReturn(tx: Tx, ret: ReturnWithOrder, actor: Actor, { releaseSellable }: { releaseSellable: boolean }) {
  const moves = await tx.stockMove.findMany({
    where: { sourceId: ret.id, sourceType: { in: ['ORDER_RETURN', 'ORDER_RETURN_SCRAP', 'ORDER_RETURN_RELEASE'] } },
    select: { sourceType: true },
  })
  if (moves.some(move => move.sourceType === 'ORDER_RETURN')) return
  const receipt = await receiveQuarantine(tx, ret, actor)
  if (!receipt) return
  const details = returnStockDetails(ret, actor)
  const total = toNum(receipt.physicalQty)
  const rawScrap = ret.scrapQuantity == null ? ret.disposition === 'SCRAP' ? receivedReturnQuantity(ret) : 0 : toNum(ret.scrapQuantity)
  const scrap = Math.min(total, rawScrap > 0 ? await toStockQty(tx, details.productId, rawScrap, details.uomId) : 0)
  const unitCost = receipt.unitCost == null ? null : toNum(receipt.unitCost)
  if (scrap > 0 && !moves.some(move => move.sourceType === 'ORDER_RETURN_SCRAP')) {
    await postStockMove(tx, {
      ...details, qty: scrap, uomQty: rawScrap, unitCost, from: LOC.RETURN_QUARANTINE, to: LOC.SCRAP, type: 'SCRAP',
      sourceType: 'ORDER_RETURN_SCRAP', lossStage: 'CUSTOMER_RETURN',
      lossReason: ret.scrapReason ?? 'CUSTOMER_RETURN_DAMAGED', note: ret.salesNote ?? ret.warehouseNote,
    })
    await ensureValuation(tx, ret.id, 'ORDER_RETURN_SCRAP')
  }
  const sellable = Math.round((total - scrap) * 1000) / 1000
  if (releaseSellable && sellable > 0 && !moves.some(move => move.sourceType === 'ORDER_RETURN_RELEASE')) {
    await postStockMove(tx, {
      ...details, qty: sellable, uomQty: receivedReturnQuantity(ret) - rawScrap, unitCost,
      from: LOC.RETURN_QUARANTINE, to: LOC.STOCK, type: 'RETURN', lot: { mode: 'fefo' },
      sourceType: 'ORDER_RETURN_RELEASE', note: ret.warehouseNote,
    })
  }
}

export async function reverseDuplicateReturnIntake(tx: Tx, ret: ReturnWithOrder, actor: Actor) {
  const posted = await tx.stockMove.findFirst({
    where: { sourceId: ret.id, sourceType: { in: ['ORDER_RETURN', 'ORDER_RETURN_SCRAP', 'ORDER_RETURN_RELEASE'] } },
    select: { id: true },
  })
  if (posted) returnError('已处置的退货不能作为重复记录合并')
  const receipt = await tx.stockMove.findFirst({
    where: { sourceId: ret.id, sourceType: 'ORDER_RETURN_QUARANTINE' }, select: { physicalQty: true, unitCost: true },
  })
  if (!receipt || !toNum(receipt.physicalQty)) return
  const sourceType = 'ORDER_RETURN_DUPLICATE_REVERSAL'
  await postStockMove(tx, {
    ...returnStockDetails(ret, actor), qty: toNum(receipt.physicalQty), unitCost: receipt.unitCost == null ? null : toNum(receipt.unitCost),
    from: LOC.RETURN_QUARANTINE, to: LOC.CUSTOMERS, type: 'RETURN', sourceType, note: '合并重复退货登记',
  })
  await ensureValuation(tx, ret.id, sourceType)
}
