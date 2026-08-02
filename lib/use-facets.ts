'use client'
/**
 * lib/use-facets.ts
 * 列表页接入 Odoo 式分面搜索的样板收敛。
 *
 * 14 个「全量加载后前端过滤」的列表页都要：facet 状态 + 累积添加 + 按维度整组删除 +
 * chip 分组渲染 + 往 OdooControlPanel 传两个 props。每页手写一遍就是 350 行重复代码，
 * 所以收进这个 hook，每页只剩 1 行。
 *
 * 语义（同维度 OR、跨维度 AND）由 groupFacets / filterByFacets 保证，本 hook 只管状态。
 */
import { useState, useCallback, useMemo } from 'react'
import { groupFacets, type Facet } from './list-filters'

export interface UseFacetsResult {
  facets: Facet[]
  /** 加一个关键词到指定维度（同维度可累积多个，组成 OR） */
  add: (key: string, value: string) => void
  /** 整组删除某个维度下的全部关键词 */
  removeGroup: (key: string) => void
  clear: () => void
  /** 直接摊进 OdooControlPanel 的 activeFilters */
  chips: { label: string; onRemove: () => void }[]
  /** 直接展开到 OdooControlPanel 上：{...controlPanelProps} */
  controlPanelProps: {
    facetFields: { key: string; label: string }[]
    onFacetAdd: (key: string, value: string) => void
  }
}

export function useFacets(fields: { key: string; label: string }[]): UseFacetsResult {
  const [facets, setFacets] = useState<Facet[]>([])

  const add = useCallback((key: string, value: string) => {
    const field = fields.find(f => f.key === key)
    if (!field || !value.trim()) return
    setFacets(prev => [...prev, { key, label: field.label, value }])
  }, [fields])

  const removeGroup = useCallback((key: string) => {
    setFacets(prev => prev.filter(f => f.key !== key))
  }, [])

  const clear = useCallback(() => setFacets([]), [])

  const chips = useMemo(
    () => groupFacets(facets).map(g => ({ label: g.chipLabel, onRemove: () => removeGroup(g.key) })),
    [facets, removeGroup],
  )

  const controlPanelProps = useMemo(
    () => ({ facetFields: fields, onFacetAdd: add }),
    [fields, add],
  )

  return { facets, add, removeGroup, clear, chips, controlPanelProps }
}
