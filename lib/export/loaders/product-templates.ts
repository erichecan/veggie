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
    spec?: string | null
    sequence?: number | null
    grossWeight?: unknown
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
          select: { isDefault: true, factor: true, spec: true, sequence: true, grossWeight: true, uom: { select: { name: true, nameZh: true } } },
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
    // 基础段 "单位:系数:是否默认" 之后，产品规格/装货顺序/毛重是可选段(见
    // app/api/products/bulk/route.ts 的 parseSaleUomsSummary)——只在这一行真的配了
    // 其中至少一项时才附加，没配过的常见情况保持原来干净的 3 段格式。
    saleUomsSummary: (r.saleUoms ?? [])
      .map(su => {
        const uomName = (ctx.isEn ? (su.uom?.name ?? su.uom?.nameZh) : (su.uom?.nameZh ?? su.uom?.name)) ?? ''
        const base = `${uomName}:${Number(su.factor ?? 0)}:${su.isDefault ? 'Y' : 'N'}`
        const hasExtra = !!su.spec || !!(su.sequence && su.sequence !== 0) || su.grossWeight != null
        if (!hasExtra) return base
        return `${base}:${su.spec ?? ''}:${su.sequence || ''}:${su.grossWeight != null ? Number(su.grossWeight) : ''}`
      })
      .join('; '),
  }))

  return { rows, total }
}
