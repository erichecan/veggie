import { prisma } from '@/lib/db'
import { CategoryTreeError, validateCategoryMove } from '@/lib/product-category-tree'

export async function writeProductCategory(id: string | null, input: Record<string, unknown>) {
  const fields: Record<string, string | null> = {}
  if (!id || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new CategoryTreeError('分类名称不能为空 / Category name is required')
    fields.name = input.name.trim()
  }
  if (input.parentId !== undefined && input.parentId !== null && typeof input.parentId !== 'string') {
    throw new CategoryTreeError('父分类无效 / Invalid parent category')
  }
  for (const key of ['nameZh', 'externalId', 'groupId', 'requiredZoneId']) {
    if (input[key] === null || typeof input[key] === 'string') fields[key] = input[key] as string | null
  }
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(610050002::bigint)`
    const categories = await tx.productCategory.findMany({ select: { id: true, parentId: true } })
    const current = id ? categories.find(category => category.id === id) : undefined
    const parentId = input.parentId === undefined ? current?.parentId ?? null : (input.parentId as string | null) || null
    validateCategoryMove(categories, id, parentId)
    const data = { ...fields, parentId }
    return id ? tx.productCategory.update({ where: { id }, data }) : tx.productCategory.create({ data: { ...data, name: fields.name! } })
  }, { timeout: 15_000 })
}
