'use client'
/**
 * 详情页「上一条 / 下一条」—— 20261013(销售单、报价单；采购单见 lib/purchase-nav-list.ts 同一思路)
 * ============================================================================
 * 列表是服务端分页，只记当前页的 id 翻到页尾就走不下去。列表页把当时的查询串(筛选+排序+搜索)
 * 记进 sessionStorage，详情页带 idsOnly=1 去同一个列表接口取整个结果集的 id 顺序。
 * 当前记录不在其中(直接打开链接、或状态变了不再符合筛选)时退回 defaultQuery。
 */
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'

export function writeRecordNavQuery(key: string, query: string) {
  try { sessionStorage.setItem(`record-nav:${key}`, query) } catch {}
}

function readRecordNavQuery(key: string): string | null {
  try { return sessionStorage.getItem(`record-nav:${key}`) } catch { return null }
}

/** 列表页用：把 useServerList 的 url(含 ?…) 和顶部搜索词拼成导航用的查询串 */
export function listNavQuery(url: string, search?: string): string {
  const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  if (search && search.trim()) q.set('search', search.trim())
  return q.toString()
}

export interface RecordNav {
  index: number
  total: number
  prevId: string | null
  nextId: string | null
}

export function useRecordNav(opts: { id: string | undefined; storageKey: string; endpoint: string; defaultQuery: string }): RecordNav {
  const { id, storageKey, endpoint, defaultQuery } = opts
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    if (!id || id === 'new') return
    let cancelled = false
    const fetchIds = (q: string) => apiGet<{ ids: string[] }>(`${endpoint}?${q}${q ? '&' : ''}idsOnly=1`).then(r => r.ids ?? [])
    ;(async () => {
      try {
        const saved = readRecordNavQuery(storageKey)
        let list = saved ? await fetchIds(saved) : []
        if (!list.includes(id)) list = await fetchIds(defaultQuery)
        if (!cancelled) setIds(list.includes(id) ? list : [])
      } catch { if (!cancelled) setIds([]) }
    })()
    return () => { cancelled = true }
  }, [id, storageKey, endpoint, defaultQuery])
  const index = id ? ids.indexOf(id) : -1
  return {
    index,
    total: ids.length,
    prevId: index > 0 ? ids[index - 1] : null,
    nextId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  }
}
