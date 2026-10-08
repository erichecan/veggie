/**
 * 商品分类的「完整路径」(Odoo 习惯的 "All / Saleable / Fruit") —— 20261008
 * ============================================================================
 * 分类是一棵树(ProductCategory.parentId)，不同父级下可以有同名子分类(两个 "Fruit")。
 * 以前价格表导入导出只认分类名，重名时随便对上一个，规则可能挂到错的分类上。
 * 导出改为写完整路径；导入按路径匹配，也兼容只写名字(唯一时)或写路径的末几段。
 */

export interface CategoryPathNode {
  id: string
  name: string
  nameZh?: string | null
  parentId?: string | null
}

export const CATEGORY_PATH_SEP = ' / '

/** id → 完整路径。环/断链按已走过的部分截断，不会死循环 */
export function categoryPathMap(categories: CategoryPathNode[], field: 'name' | 'nameZh' = 'name'): Map<string, string> {
  const byId = new Map(categories.map(c => [c.id, c]))
  const out = new Map<string, string>()
  for (const c of categories) {
    const parts: string[] = []
    const seen = new Set<string>()
    let cur: CategoryPathNode | undefined = c
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      parts.unshift((field === 'nameZh' ? cur.nameZh || cur.name : cur.name).trim())
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    out.set(c.id, parts.join(CATEGORY_PATH_SEP))
  }
  return out
}

function pathKey(raw: string): string[] {
  return raw.split('/').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export type CategoryResolveResult =
  | { id: string }
  | { id?: undefined; reason: 'not_found' }
  | { id?: undefined; reason: 'ambiguous'; candidates: string[] }

/**
 * 按名字或路径找分类：
 *   - 完整路径精确匹配(英文名或中文名路径都行)；
 *   - 否则按「路径末尾几段」匹配——只写 "Fruit" 或 "Saleable / Fruit" 也行，前提是只对上一个；
 *   - 对上多个 → ambiguous(调用方提示用户写完整路径)，不猜。
 */
export function buildCategoryResolver(categories: CategoryPathNode[]): (raw: string) => CategoryResolveResult {
  const paths = [categoryPathMap(categories, 'name'), categoryPathMap(categories, 'nameZh')]
  const entries: Array<{ id: string; segs: string[]; display: string }> = []
  for (const c of categories) {
    const seenKeys = new Set<string>()
    for (const m of paths) {
      const p = m.get(c.id)
      if (!p) continue
      const segs = pathKey(p)
      const k = segs.join('/')
      if (seenKeys.has(k)) continue
      seenKeys.add(k)
      entries.push({ id: c.id, segs, display: paths[0].get(c.id) ?? p })
    }
  }
  return (raw: string) => {
    const want = pathKey(raw)
    if (want.length === 0) return { reason: 'not_found' }
    const exact = new Set(entries.filter(e => e.segs.join('/') === want.join('/')).map(e => e.id))
    if (exact.size === 1) return { id: [...exact][0] }
    const suffix = exact.size > 1 ? exact : new Set(
      entries.filter(e => e.segs.length >= want.length && e.segs.slice(e.segs.length - want.length).join('/') === want.join('/')).map(e => e.id),
    )
    if (suffix.size === 1) return { id: [...suffix][0] }
    if (suffix.size === 0) return { reason: 'not_found' }
    const display = paths[0]
    return { reason: 'ambiguous', candidates: [...suffix].map(id => display.get(id) ?? id) }
  }
}
