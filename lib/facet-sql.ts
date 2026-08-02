/**
 * lib/facet-sql.ts
 * 分面搜索的「服务端执行器」——把 URL 上的 f_* 参数编译成 Prisma where 子句。
 * 与客户端执行器 lib/facet-client.ts 共用同一套语义：同维度内 OR，跨维度 AND。
 */
import { facetParamName } from './list-filters'

export interface FacetDef {
  /** 维度 key，与前端 Facet.key 对应。不要声明 'all'（它走各 API 自己的 search 参数） */
  key: string
  /** 下拉里显示的维度名 */
  label: string
  /** 单个关键词 → 一条 Prisma where 子句；需查库的维度（如司机）可返回 Promise */
  toClause: (value: string) => Record<string, unknown> | Promise<Record<string, unknown>>
}

/**
 * 返回可直接并入 `where.AND` 的子句数组。
 * 每个维度产出一个元素（同维度多值包成 OR），元素之间由调用方的 AND 串联。
 */
export async function buildFacetWhere(
  sp: URLSearchParams,
  defs: FacetDef[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (const def of defs) {
    const values = sp.getAll(facetParamName(def.key)).map(v => v.trim()).filter(Boolean)
    if (values.length === 0) continue
    const clauses = await Promise.all(values.map(v => def.toClause(v)))
    out.push(clauses.length === 1 ? clauses[0] : { OR: clauses })
  }
  return out
}
