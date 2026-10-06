import { buildCategoryTree, validateCategoryMove, type CategoryNode, type CategoryTreeNode } from './product-category-tree'

export interface CategoryNavigationEntry<T> {
  node: CategoryTreeNode<T>
  path: CategoryTreeNode<T>[]
}

export function buildCategoryNavigation<T extends CategoryNode>(categories: T[]): CategoryNavigationEntry<T>[] {
  const entries: CategoryNavigationEntry<T>[] = []
  function visit(nodes: CategoryTreeNode<T>[], ancestors: CategoryTreeNode<T>[]) {
    for (const node of nodes) {
      const path = [...ancestors, node]
      entries.push({ node, path })
      visit(node.children, path)
    }
  }
  visit(buildCategoryTree(categories), [])
  return entries
}

export function categoryParentChoices<T extends CategoryNode>(categories: T[], id: string | null) {
  return buildCategoryNavigation(categories).filter(({ node }) => {
    try {
      validateCategoryMove(categories, id, node.id)
      return true
    } catch {
      return false
    }
  })
}
