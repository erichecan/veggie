/** 对账单导出取数 —— where 复用 lib/statements-query.ts，与列表 API 同一份。 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { buildStatementsWhere } from '@/lib/statements-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { StatementExportRow } from '../columns/statements'

export async function loadStatementsForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<StatementExportRow>> {
  const where = buildStatementsWhere(ctx.searchParams)

  const [total, rows] = await Promise.all([
    prisma.statement.count({ where }),
    prisma.statement.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: ctx.limit,
    }),
  ])

  const out: StatementExportRow[] = (serializeApi(rows) as Array<Record<string, unknown>>).map(r => ({
    ...(r as unknown as StatementExportRow),
    orderCount: ((r.orderIds ?? []) as unknown[]).length,
    invoiceCount: ((r.invoiceIds ?? []) as unknown[]).length,
  }))

  return { rows: out, total }
}
