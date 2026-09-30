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
  purchaseUom?: { name?: string | null; nameZh?: string | null } | null
  category?: { name?: string | null; nameZh?: string | null } | null
  saleUoms?: Array<{
    isDefault: boolean
    factor: unknown
    uom?: { name?: string | null; nameZh?: string | null } | null
  }>
}

export async function loadProductTemplatesForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<ProductExportRow>> {
  const where = await buildProductTemplatesWhere(ctx.searchParams)

  const [total, templates] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: {
        uom: true,
        purchaseUom: true,
        category: true,
        saleUoms: {
          where: { active: true },
          orderBy: { sequence: 'asc' },
          select: { isDefault: true, factor: true, uom: { select: { name: true, nameZh: true } } },
        },
      },
      orderBy: PRODUCT_TEMPLATE_ORDER_BY,
      take: ctx.limit,
    }),
  ])

  const serialized = serializeApi(templates) as RawRow[]

  const rows: ProductExportRow[] = serialized.map(r => ({
    ...(r as unknown as ProductExportRow),
    // uom / category 在屏幕上按 locale 显示名字，导出跟着走同一个规则
    uomName: (ctx.isEn ? (r.uom?.name ?? r.uom?.nameZh) : (r.uom?.nameZh ?? r.uom?.name)) ?? '',
    purchaseUomName: (ctx.isEn ? (r.purchaseUom?.name ?? r.purchaseUom?.nameZh) : (r.purchaseUom?.nameZh ?? r.purchaseUom?.name)) ?? '',
    categoryName: (ctx.isEn ? (r.category?.name ?? r.category?.nameZh) : (r.category?.nameZh ?? r.category?.name)) ?? '',
    saleUomsSummary: (r.saleUoms ?? [])
      .map(su => {
        const uomName = (ctx.isEn ? (su.uom?.name ?? su.uom?.nameZh) : (su.uom?.nameZh ?? su.uom?.name)) ?? ''
        return `${uomName}:${Number(su.factor ?? 0)}:${su.isDefault ? 'Y' : 'N'}`
      })
      .join('; '),
  }))

  return { rows, total }
}
