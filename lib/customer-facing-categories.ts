import { prisma } from './db'

/**
 * `ProductCategory` 混杂着一批不该给客户看的系统/测试类目（"All"、"Stockable"、
 * "Saleable"、"TEST" 等，Odoo 导入历史遗留，20260926 临时名单，过滤名单需要跟着
 * 数据变化维护）。customer-portal 的分类导航与 /shop 匿名浏览的分类导航共用这份
 * 过滤 + 聚合逻辑——两边各抄一份的话，名单改了很容易漏掉另一处（20261020 code
 * review 发现过一次：两处 where 条件就已经不同步）。
 */
const HIDDEN_CATEGORY_NAMES = new Set([
  'all', 'stockable', 'saleable', 'test', 'all / stockable /frozen',
])

export type CustomerFacingCategory = { id: string; name: string; nameZh: string | null; count: number }

export async function listCustomerFacingCategories(
  extraWhere: { canBeSold?: boolean; showInPortal?: boolean } = {},
): Promise<CustomerFacingCategory[]> {
  const grouped = await prisma.product.groupBy({
    by: ['categoryId'],
    where: { status: 'ACTIVE', categoryId: { not: null }, ...extraWhere },
    _count: { _all: true },
  })

  const categoryIds = grouped.map((g) => g.categoryId).filter((id): id is string => !!id)
  const categories = await prisma.productCategory.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, name: true, nameZh: true },
  })
  const byId = new Map(categories.map((c) => [c.id, c]))

  return grouped
    .map((g) => {
      const cat = g.categoryId ? byId.get(g.categoryId) : null
      if (!cat) return null
      if (HIDDEN_CATEGORY_NAMES.has(cat.name.trim().toLowerCase())) return null
      return { id: cat.id, name: cat.name, nameZh: cat.nameZh, count: g._count._all }
    })
    .filter((c): c is CustomerFacingCategory => !!c)
    .sort((a, b) => b.count - a.count)
}
