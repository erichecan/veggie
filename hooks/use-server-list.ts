'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { apiGet } from '@/lib/api'
import { toast } from 'sonner'

export interface ServerListPage<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

interface Options {
  /** Base API URL, e.g. "/api/orders". Static params go here as query string. */
  url: string
  pageSize?: number
  /** Debounce delay for search changes (ms) */
  debounceMs?: number
  /** Called with error message instead of showing toast */
  onError?: (msg: string) => void
}

interface Controls {
  setPage: (p: number) => void
  setPageSize: (ps: number) => void
  setSearch: (q: string) => void
  refresh: () => void
  search: string
  loading: boolean
}

/**
 * useServerList — reusable hook for server-side paginated lists.
 *
 * Usage:
 *   const { data, total, page, pageSize, totalPages, loading, setPage, setPageSize, setSearch, refresh } =
 *     useServerList<Order>({ url: '/api/orders?status=PENDING&include_lines=false', pageSize: 40 })
 *
 * The API must accept ?page=&pageSize=&search= and return:
 *   { data: T[], total: number, page: number, pageSize: number, totalPages: number }
 *
 * pageSize starts from options.pageSize but is internal state from then on (setPageSize can change
 * it at runtime, e.g. a user-editable "rows per page" control) — the caller doesn't need to manage
 * a separate pageSize state itself.
 */
export function useServerList<T>(options: Options): ServerListPage<T> & Controls {
  const { url, pageSize: initialPageSize = 40, debounceMs = 350, onError } = options

  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPageRaw] = useState(1)
  const [pageSize, setPageSizeRaw] = useState(initialPageSize)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [search, setSearchRaw] = useState('')

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // stable references for the current values used inside fetch
  const searchRef = useRef(search)
  const pageRef = useRef(page)
  const pageSizeRef = useRef(pageSize)
  searchRef.current = search
  pageRef.current = page
  pageSizeRef.current = pageSize

  const fetchPage = useCallback(async (p: number, q: string, ps: number) => {
    setLoading(true)
    try {
      const sep = url.includes('?') ? '&' : '?'
      const params = new URLSearchParams({ page: String(p), pageSize: String(ps) })
      if (q) params.set('search', q)
      const res = await apiGet<ServerListPage<T>>(`${url}${sep}${params}`)
      setData(res.data ?? [])
      setTotal(res.total ?? 0)
      setPageRaw(res.page ?? p)
      setPageSizeRaw(res.pageSize ?? ps)
      setTotalPages(res.totalPages ?? Math.ceil((res.total ?? 0) / ps))
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      if (onError) onError(msg)
      else toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [url, onError])

  // Initial fetch
  useEffect(() => {
    fetchPage(1, '', pageSizeRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const setPage = useCallback((p: number) => {
    fetchPage(p, searchRef.current, pageSizeRef.current)
  }, [fetchPage])

  // 改每页条数后必须回到第 1 页重新拉取(否则 skip 用旧 pageSize 算出来的 offset 会错位)
  const setPageSize = useCallback((ps: number) => {
    fetchPage(1, searchRef.current, ps)
  }, [fetchPage])

  const setSearch = useCallback((q: string) => {
    setSearchRaw(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchPage(1, q, pageSizeRef.current)
    }, debounceMs)
  }, [fetchPage, debounceMs])

  const refresh = useCallback(() => {
    fetchPage(pageRef.current, searchRef.current, pageSizeRef.current)
  }, [fetchPage])

  return { data, total, page, pageSize, totalPages, loading, setPage, setPageSize, setSearch, refresh, search }
}
