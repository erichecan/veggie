/**
 * 客户导出取数 —— where 复用 lib/customers-query.ts，与列表 API 同一份，
 * 行级隔离（销售只看自己名下客户）跟着一起生效。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { buildCustomersWhere } from '@/lib/customers-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { CustomerExportRow } from '../columns/customers'

export async function loadCustomersForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<CustomerExportRow>> {
  const where = await buildCustomersWhere(ctx.searchParams, ctx.user)

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      include: {
        // CustomerPricelist 不设 FK（宽松引用，见 schema 注释），拿不到关联对象，
        // 只能拿到 pricelistId，名字下面单独查一次
        pricelists: { orderBy: { sequence: 'asc' } },
        salesUser: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
      take: ctx.limit,
    }),
  ])

  const serialized = serializeApi(customers) as Array<Record<string, unknown>>
  const pricelistIds = [...new Set(
    serialized.flatMap(c => ((c.pricelists ?? []) as Array<{ pricelistId: string }>).map(l => l.pricelistId)),
  )]
  const nameById = new Map(
    pricelistIds.length > 0
      ? (await prisma.odooPricelist.findMany({
          where: { id: { in: pricelistIds } },
          select: { id: true, name: true },
        })).map(p => [p.id, p.name])
      : [],
  )

  const rows: CustomerExportRow[] = serialized.map(c => {
    const links = (c.pricelists ?? []) as Array<{ pricelistId: string }>
    return {
      ...(c as unknown as CustomerExportRow),
      // 屏幕上多价格表显示成「主表 (+2)」，导出给全名列表 —— CSV 是拿去加工的，
      // 省略号式的摘要在这里没有意义
      pricelistNames: links.map(l => nameById.get(l.pricelistId) ?? l.pricelistId).join(' / '),
      salesman: (c.salesUser as { name?: string } | null)?.name ?? null,
    }
  })

  return { rows, total }
}
