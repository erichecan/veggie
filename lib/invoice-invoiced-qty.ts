/**
 * B-2: 回写 OrderLine.invoicedQty = deliveredQty
 * ================================================================================
 * 优先按发票行携带的 orderLineId 精确到行——部分/行拆分开票只刷被开票的那些行，
 * 不再按整单 orderId 粗暴刷新(原实现的病灶)。无 orderLineId 的旧发票/未映射行 →
 * 回退按整单 saleOrderIds 刷新(向后兼容)。幂等:恒 = deliveredQty,重跑安全。
 *
 * 说明:本函数解决「行拆分开票」(某些行开这张、另一些开那张)的误刷问题;
 * 「部分数量开票」(某行 100 交货只开 60)仍设为 deliveredQty,需专门功能另计,见 docs/20260701 B-2。
 */
type RawTx = { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }

/** 从发票 Json 行(可能来自 DB Json 或内存 recomputedLines)提取非空 orderLineId */
export function orderLineIdsFromInvoiceLines(invoiceLines: unknown): string[] {
  if (!Array.isArray(invoiceLines)) return []
  return invoiceLines
    .map((l) => (l && typeof l === 'object' ? (l as { orderLineId?: unknown }).orderLineId : null))
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
}

export async function writebackInvoicedQty(
  tx: RawTx,
  invoiceLines: unknown,
  saleOrderIds: string[],
): Promise<void> {
  const orderLineIds = orderLineIdsFromInvoiceLines(invoiceLines)
  if (orderLineIds.length > 0) {
    await tx.$executeRawUnsafe(
      `UPDATE "OrderLine" SET "invoicedQty" = "deliveredQty", "updatedAt" = NOW() WHERE "id" = ANY($1::text[])`,
      orderLineIds,
    )
    return
  }
  if (saleOrderIds.length > 0) {
    await tx.$executeRawUnsafe(
      `UPDATE "OrderLine" SET "invoicedQty" = "deliveredQty", "updatedAt" = NOW() WHERE "orderId" = ANY($1::text[])`,
      saleOrderIds,
    )
  }
}
