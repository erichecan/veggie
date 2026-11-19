import type { Prisma } from '@/lib/generated/prisma/client'
type Tx = Prisma.TransactionClient

export function returnError(message: string, status = 409): never { throw Object.assign(new Error(message), { status }) }

/** Same lock order at every invoice/return entry: Order (sorted), then return/request/invoice. */
export async function lockReturnOrders(tx: Tx, ids: string[]) {
  if (!ids.length) return
  const sorted = [...new Set(ids)].sort()
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`
}
export async function assertReturnsResolved(tx: Pick<Tx, 'orderReturn'>, orderIds: string[]) {
  if (!orderIds.length) return
  const pending = await tx.orderReturn.findFirst({
    where: { orderId: { in: orderIds }, OR: [
      { status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } },
      { status: 'APPROVED', workflowVersion: 2 },
    ] }, select: { productName: true },
  })
  if (pending) returnError(`商品「${pending.productName}」的退货尚未完成仓库、销售和会计处理；可先核销回单，暂不能开票或过账`)
}

