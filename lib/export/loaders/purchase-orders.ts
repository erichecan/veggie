/** 采购单导出取数 —— where 复用 lib/purchase-orders-query.ts，与列表 API 同一份。 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { buildPurchaseOrdersWhere } from '@/lib/purchase-orders-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { PurchaseOrderExportRow } from '../columns/purchase-orders'

export async function loadPurchaseOrdersForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<PurchaseOrderExportRow>> {
  const baseWhere = await buildPurchaseOrdersWhere(ctx.searchParams)
  // 列表多选后「导出选中」（20261020）：?ids= 只导这几张，忽略分页
  const ids = (ctx.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const where = ids.length ? { AND: [baseWhere, { id: { in: ids } }] } : baseWhere

  const [total, rows] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: ctx.limit,
      include: { lines: { orderBy: { sequence: 'asc' } } },
    }),
  ])

  // PurchaseOrder 只存 supplierId，名字在 Customer 表里（与列表 API 同样的补全方式）
  const supplierIds = [...new Set(rows.map(r => r.supplierId).filter(Boolean))]
  const suppliers = supplierIds.length > 0
    ? await prisma.customer.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(suppliers.map(s => [s.id, s.name]))

  // 录入人：createdBy 存的是 userId，显示名与列表页同一口径（name 优先，缺了退 email）
  const creatorIds = [...new Set(rows.map(r => r.createdBy).filter((v): v is string => !!v))]
  const creators = creatorIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true, email: true } })
    : []
  const creatorById = new Map(creators.map(u => [u.id, u.name || u.email]))
  const productIds = [...new Set(rows.flatMap(r => ((r.lines ?? []) as Array<{ productId?: string }>).map(l => l.productId).filter((v): v is string => !!v)))]
  const products = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, internalRef: true } }) : []
  const productRefById = new Map(products.map(p => [p.id, p.internalRef]))

  const out: PurchaseOrderExportRow[] = (serializeApi(rows) as Array<Record<string, unknown>>).flatMap(r => {
    const lines = (r.lines ?? []) as Array<Record<string, unknown>>
    const header = { ...(r as unknown as PurchaseOrderExportRow), supplierName: nameById.get(r.supplierId as string) ?? '',
      createdByName: creatorById.get(r.createdBy as string) ?? '', lineCount: lines.length }
    return (lines.length ? lines : [null]).map(line => ({ ...header,
      productName: line?.productName as string | undefined,
      productRef: productRefById.get(String(line?.productId ?? '')) ?? '',
      bestBefore: line?.bestBefore as string | undefined,
      quantity: line?.orderedQty as number | undefined, unitCost: line?.unitCost as number | undefined,
      taxRate: line?.taxRate as number | undefined, lineUntaxed: line?.subtotalExTax as number | undefined,
    }))
  })

  return { rows: out, total }
}
