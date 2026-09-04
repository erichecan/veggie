/**
 * lib/facet-client.ts
 * 分面搜索的「客户端执行器」——供全量加载后在前端过滤的列表页使用。
 * 与服务端执行器 lib/facet-sql.ts 共用同一套语义：同维度内 OR，跨维度 AND。
 */
import type { Facet } from './list-filters'

export interface ClientFacetDef<T> {
  /** 维度 key，与 Facet.key 对应 */
  key: string
  /** 下拉里显示的维度名（中文） */
  label: string
  /** 下拉里显示的维度名（英文）。不传时英文界面下会回退显示中文 label —— 新增维度定义时应一并填上。 */
  labelEn?: string
  /** 从一行数据里取出该维度所有可被匹配的文本 */
  values: (row: T) => (string | null | undefined)[]
}

/** 把 ClientFacetDef 转成 useFacets/OdooControlPanel 需要的 {key,label}，按 isEn 选中英文名。 */
export function localizeClientFacetDefs<T>(defs: ClientFacetDef<T>[], isEn = false): { key: string; label: string }[] {
  return defs.map(d => ({ key: d.key, label: isEn ? (d.labelEn ?? d.label) : d.label }))
}

export function filterByFacets<T>(rows: T[], facets: Facet[], defs: ClientFacetDef<T>[]): T[] {
  const defByKey = new Map(defs.map(d => [d.key, d]))

  // 按维度分组：同组内的值 OR，组与组之间 AND
  const groups = new Map<string, string[]>()
  for (const f of facets) {
    const v = f.value.trim().toLowerCase()
    if (!v || !defByKey.has(f.key)) continue
    const list = groups.get(f.key)
    if (list) list.push(v)
    else groups.set(f.key, [v])
  }
  if (groups.size === 0) return rows

  return rows.filter(row =>
    [...groups].every(([key, needles]) => {
      const haystack = defByKey.get(key)!.values(row).map(v => (v ?? '').toLowerCase())
      return needles.some(n => haystack.some(h => h.includes(n)))
    }),
  )
}
