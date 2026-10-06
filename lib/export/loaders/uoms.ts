import { prisma } from '@/lib/db'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { UomExportRow } from '../columns/uoms'

export async function loadUomsForExport(ctx: ExportLoadContext): Promise<ExportLoadResult<UomExportRow>> {
  const [total, uoms] = await Promise.all([
    prisma.uom.count({}),
    prisma.uom.findMany({
      include: { category: true },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
      take: ctx.limit,
    }),
  ])
  const rows: UomExportRow[] = uoms.map(u => ({
    name: u.name,
    nameZh: u.nameZh,
    categoryName: u.category?.name ?? null,
    goodsType: u.goodsType,
    expandByCustomer: u.expandByCustomer,
    active: u.active,
  }))
  return { rows, total }
}
