import { prisma } from '@/lib/db'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { ProductCategoryExportRow } from '../columns/product-categories'

export async function loadProductCategoriesForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<ProductCategoryExportRow>> {
  const [total, categories] = await Promise.all([
    prisma.productCategory.count({}),
    prisma.productCategory.findMany({
      include: { group: true, requiredZone: true },
      orderBy: { name: 'asc' },
      take: ctx.limit,
    }),
  ])
  const rows: ProductCategoryExportRow[] = categories.map(c => ({
    externalId: c.externalId,
    name: c.name,
    nameZh: c.nameZh,
    groupName: c.group?.name ?? null,
    requiredZoneName: c.requiredZone?.name ?? null,
  }))
  return { rows, total }
}
