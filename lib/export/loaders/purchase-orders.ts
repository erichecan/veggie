/** 采购单导出取数 —— where 复用 lib/purchase-orders-query.ts，与列表 API 同一份。 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { buildPurchaseOrdersWhere } from '@/lib/purchase-orders-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { PurchaseOrderExportRow } from '../columns/purchase-orders'

export async function loadPurchaseOrdersForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<PurchaseOrderExportRow>> {
  const where = await buildPurchaseOrdersWhere(ctx.searchParams)

  const [total, rows] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: ctx.limit,
      include: { lines: { select: { id: true } } },
    }),
  ])

  // PurchaseOrder 只存 supplierId，名字在 Customer 表里（与列表 API 同样的补全方式）
  const supplierIds = [...new Set(rows.map(r => r.supplierId).filter(Boolean))]
  const suppliers = supplierIds.length > 0
    ? await prisma.customer.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(suppliers.map(s => [s.id, s.name]))

  const out: PurchaseOrderExportRow[] = (serializeApi(rows) as Array<Record<string, unknown>>).map(r => ({
    ...(r as unknown as PurchaseOrderExportRow),
    supplierName: nameById.get(r.supplierId as string) ?? '',
    lineCount: ((r.lines ?? []) as unknown[]).length,
  }))

  return { rows: out, total }
}
