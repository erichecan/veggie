/**
 * 商品导出取数 —— where 复用 lib/products-query.ts，与列表 API 同一份。
 * 排序也用列表那一套(PRODUCT_TEMPLATE_ORDER_BY)，导出的行序和屏幕上一致。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import {
  buildProductTemplatesWhere,
  PRODUCT_TEMPLATE_ORDER_BY,
} from '@/lib/products-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { ProductExportRow } from '../columns/product-templates'

interface RawRow extends Record<string, unknown> {
  id: string
  uom?: { name?: string | null; nameZh?: string | null } | null
  category?: { name?: string | null; nameZh?: string | null } | null
}

export async function loadProductTemplatesForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<ProductExportRow>> {
  const where = await buildProductTemplatesWhere(ctx.searchParams)

  const [total, templates] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: { uom: true, category: true },
      orderBy: PRODUCT_TEMPLATE_ORDER_BY,
      take: ctx.limit,
    }),
  ])

  const serialized = serializeApi(templates) as RawRow[]

  const rows: ProductExportRow[] = serialized.map(r => ({
    ...(r as unknown as ProductExportRow),
    // uom / category 在屏幕上按 locale 显示名字，导出跟着走同一个规则
    uomName: (ctx.isEn ? (r.uom?.name ?? r.uom?.nameZh) : (r.uom?.nameZh ?? r.uom?.name)) ?? '',
    categoryName: (ctx.isEn ? (r.category?.name ?? r.category?.nameZh) : (r.category?.nameZh ?? r.category?.name)) ?? '',
  }))

  return { rows, total }
}
