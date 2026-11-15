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

export type CustomerFacingCategory = { id: string; parentId: string | null; name: string; nameZh: string | null; count: number }

export async function listCustomerFacingCategories(
  extraWhere: { canBeSold?: boolean; showInPortal?: boolean } = {},
): Promise<CustomerFacingCategory[]> {
  const grouped = await prisma.product.groupBy({
    by: ['categoryId'],
    where: { status: 'ACTIVE', categoryId: { not: null }, ...extraWhere },
    _count: { _all: true },
  })

  const categories = await prisma.productCategory.findMany({
    select: { id: true, parentId: true, name: true, nameZh: true },
  })
  const byId = new Map(categories.map((c) => [c.id, c]))
  const directCounts = new Map(grouped.flatMap((g) => g.categoryId ? [[g.categoryId, g._count._all] as const] : []))
  const visibleIds = new Set<string>()

  // Include ancestors with no directly assigned products so portal users can
  // navigate the same hierarchy configured in Product Categories.
  for (const id of directCounts.keys()) {
    let current = byId.get(id)
    while (current) {
      if (!HIDDEN_CATEGORY_NAMES.has(current.name.trim().toLowerCase())) visibleIds.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  }

  return [...visibleIds]
    .map((id) => {
      const cat = byId.get(id)
      if (!cat) return null
      return { id: cat.id, parentId: cat.parentId, name: cat.name, nameZh: cat.nameZh, count: directCounts.get(cat.id) ?? 0 }
    })
    .filter((c): c is CustomerFacingCategory => !!c)
    .sort((a, b) => b.count - a.count)
}

/** Selecting a parent category includes its visible child categories as well. */
export async function getCustomerFacingCategoryScope(categoryId: string): Promise<string[]> {
  const categories = await prisma.productCategory.findMany({
    select: { id: true, parentId: true, name: true },
  })
  const byId = new Map(categories.map((category) => [category.id, category]))
  if (!byId.has(categoryId)) return [categoryId]

  const childrenByParent = new Map<string, typeof categories>()
  for (const category of categories) {
    if (!category.parentId) continue
    const children = childrenByParent.get(category.parentId) ?? []
    children.push(category)
    childrenByParent.set(category.parentId, children)
  }

  const result: string[] = []
  const pending = [categoryId]
  while (pending.length) {
    const id = pending.pop()!
    const category = byId.get(id)
    if (!category || HIDDEN_CATEGORY_NAMES.has(category.name.trim().toLowerCase())) continue
    result.push(id)
    for (const child of childrenByParent.get(id) ?? []) pending.push(child.id)
  }
  return result.length ? result : [categoryId]
}
