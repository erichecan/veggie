export interface CategoryNode {
  id: string
  parentId?: string | null
}

export type CategoryTreeNode<T> = T & { children: CategoryTreeNode<T>[]; depth: number }

export class CategoryTreeError extends Error {}

export function validateCategoryMove(categories: CategoryNode[], id: string | null, parentId: string | null) {
  const byId = new Map(categories.map(category => [category.id, category]))
  if (id && !byId.has(id)) throw new CategoryTreeError('分类不存在 / Category not found')
  let depth = 1
  let ancestorId = parentId
  const visited = new Set(id ? [id] : [])
  while (ancestorId) {
    if (visited.has(ancestorId)) throw new CategoryTreeError('不能将自己或子分类设为父级 / Cannot select self or descendant as parent')
    visited.add(ancestorId)
    const ancestor = byId.get(ancestorId)
    if (!ancestor) throw new CategoryTreeError('父分类不存在 / Parent category not found')
    depth += 1
    ancestorId = ancestor.parentId ?? null
  }
  const children = new Map<string, string[]>()
  for (const category of categories) {
    if (category.parentId) children.set(category.parentId, [...(children.get(category.parentId) ?? []), category.id])
  }
  function height(nodeId: string, path: Set<string>): number {
    if (path.has(nodeId)) throw new CategoryTreeError('分类存在循环 / Category cycle detected')
    const nextPath = new Set(path).add(nodeId)
    return 1 + Math.max(0, ...(children.get(nodeId) ?? []).map(childId => height(childId, nextPath)))
  }
  if (depth + (id ? height(id, new Set()) : 1) - 1 > 3) {
    throw new CategoryTreeError('商品分类最多支持三级（包含子分类） / Categories support at most 3 levels, including descendants')
  }
}

export function buildCategoryTree<T extends CategoryNode>(categories: T[]): CategoryTreeNode<T>[] {
  const nodes = new Map(categories.map(category => [category.id, { ...category, children: [], depth: 1 } as CategoryTreeNode<T>]))
  const roots: CategoryTreeNode<T>[] = []
  for (const category of categories) {
    const node = nodes.get(category.id)!
    const parent = category.parentId ? nodes.get(category.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  function setDepth(node: CategoryTreeNode<T>, depth: number) {
    node.depth = depth
    node.children.forEach(child => setDepth(child, depth + 1))
  }
  roots.forEach(root => setDepth(root, 1))
  return roots
}
