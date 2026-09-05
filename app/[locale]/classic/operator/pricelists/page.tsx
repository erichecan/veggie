'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { OdooPricelist, Product } from '@/lib/types'
import { formatDateTime } from '@/lib/format-date'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'
import type { Facet } from '@/lib/list-filters'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'

const PAGE_SIZE = 80

/**
 * 搜索出结果点进去改保存、退回来接着改下一条——这个来回不能把筛选条件冲掉，
 * 所以把列表页的搜索/筛选状态整体存进 sessionStorage，每次状态变化都回写，
 * 列表页每次挂载（含从详情页返回）都从这里恢复，而不是从空状态重新来过。
 */
const LIST_STATE_KEY = 'classic_pricelists_list_state'

interface SavedListState {
  searchInput: string
  facets: Facet[]
  columnFilters: Record<string, string>
  selectableFilter: boolean
  activeListFilter: boolean
  groupBy: string
  page: number
}

function readSavedListState(): SavedListState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(LIST_STATE_KEY)
    return raw ? JSON.parse(raw) as SavedListState : null
  } catch {
    return null
  }
}

export default function ClassicPricelistsPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [saved] = useState<SavedListState | null>(() => readSavedListState())
  const [lists, setLists] = useState<OdooPricelist[]>([])
  const [productNameById, setProductNameById] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState(saved?.searchInput ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(saved?.columnFilters ?? {})
  const [isReadMode, setIsReadMode] = useState(true)
  const [page, setPage] = useState(saved?.page ?? 1)
  const [selectableFilter, setSelectableFilter] = useState(saved?.selectableFilter ?? false)
  const [activeListFilter, setActiveListFilter] = useState(saved?.activeListFilter ?? false)
  const [groupBy, setGroupBy] = useState(saved?.groupBy ?? '')

  async function load() {
    setLoading(true)
    try {
      const [data, products] = await Promise.all([
        apiGet<OdooPricelist[]>('/api/pricelists'),
        apiGet<Product[]>('/api/products').catch(() => [] as Product[]),
      ])
      setLists([...data].sort((a, b) => a.sequence - b.sequence))
      setProductNameById(new Map(products.map(p => [p.id, p.name])))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load pricelists' : '加载价格表失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate() {
    const payload = {
      name: '',
      currency: 'EUR',
      items: [],
      sequence: 99,
      selectable: true,
      active: true,
      updatedAt: new Date().toISOString(),
    }
    try {
      const created = await apiPost<OdooPricelist>('/api/pricelists', payload)
      router.push(`${prefix}/classic/operator/pricelists/${created.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Create failed' : '创建失败'))
    }
  }

  const facetDefs = useMemo<ClientFacetDef<OdooPricelist>[]>(() => [
    { key: 'name',     label: '名称', labelEn: 'Name',     values: r => [r.name] },
    { key: 'currency', label: '货币', labelEn: 'Currency', values: r => [r.currency] },
    {
      key: 'product', label: '产品', labelEn: 'Product',
      // OdooPricelistItem 只存 productTemplateId/productVariantId，没有商品名快照，
      // 靠列表页额外拉一份 /api/products 建 id→名称映射再匹配（同 barcode 处理原则）。
      values: r => r.items.map(it => {
        const pid = it.productVariantId ?? it.productTemplateId
        return pid ? productNameById.get(pid) : undefined
      }).filter((v): v is string => !!v),
    },
  ], [productNameById])

  const { facets, chips, controlPanelProps } = useFacets(localizeClientFacetDefs(facetDefs, isEn), saved?.facets)

  // 搜索/筛选状态整体持久化，供从详情页返回时恢复（见 LIST_STATE_KEY 顶部注释）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const state: SavedListState = { searchInput, facets, columnFilters, selectableFilter, activeListFilter, groupBy, page }
    try { sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify(state)) } catch { /* 存储不可用时静默跳过,不影响筛选本身 */ }
  }, [searchInput, facets, columnFilters, selectableFilter, activeListFilter, groupBy, page])

  const filteredLists = useMemo(() => {
    let rows = filterByFacets(lists, facets, facetDefs)
    if (searchInput) {
      rows = rows.filter(pl => pl.name.toLowerCase().includes(searchInput.toLowerCase()))
    }
    if (selectableFilter) rows = rows.filter(pl => pl.selectable)
    if (activeListFilter) rows = rows.filter(pl => pl.active)
    for (const [key, val] of Object.entries(columnFilters)) {
      if (!val) continue
      if (key.endsWith('_from')) {
        const base = key.slice(0, -5)
        rows = rows.filter(pl => {
          const v = String((pl as unknown as Record<string, unknown>)[base] ?? '')
          return !v || v >= val
        })
      } else if (key.endsWith('_to')) {
        const base = key.slice(0, -3)
        rows = rows.filter(pl => {
          const v = String((pl as unknown as Record<string, unknown>)[base] ?? '')
          return !v || v <= val + 'T23:59:59'
        })
      } else {
        rows = rows.filter(pl => {
          const v = String((pl as unknown as Record<string, unknown>)[key] ?? '').toLowerCase()
          return v.includes(val.toLowerCase())
        })
      }
    }
    return rows
  }, [lists, facets, facetDefs, searchInput, columnFilters, selectableFilter, activeListFilter])

  const pagedLists = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredLists.slice(start, start + PAGE_SIZE)
  }, [filteredLists, page])

  const columns: OdooColumn[] = [
    {
      key: 'name',
      label: 'Pricelist Name',
      filterType: 'text',
      render: (v, row) => {
        const pl = row as unknown as OdooPricelist
        return (
          <span className="font-medium" style={{ color: '#875A7B' }}>
            {pl.name || <span className="text-gray-400 italic">{isEn ? '(Unnamed)' : '（未命名）'}</span>}
            {!pl.active && (
              <span className="ml-2 text-xs text-gray-400 border border-gray-300 rounded px-1 font-normal">{isEn ? 'Archived' : '已停用'}</span>
            )}
          </span>
        )
      },
    },
    {
      key: 'updatedAt',
      label: 'Last Updated on',
      filterType: 'date-range',
      render: (v) => (
        <span className="text-xs text-gray-500">
          {v ? formatDateTime(String(v)) : '—'}
        </span>
      ),
    },
    {
      key: 'currency',
      label: 'Currency',
      filterType: 'text',
      render: (v) => <span className="text-gray-700">{String(v ?? '')}</span>,
    },
    {
      key: 'selectable',
      label: 'Selectable',
      render: (v) => v
        ? <span className="inline-flex w-4 h-4 items-center justify-center rounded-sm text-white text-xs" style={{ background: '#875A7B' }}>✓</span>
        : <span className="inline-block w-4 h-4 border border-gray-300 rounded-sm" />,
    },
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Pricelists'] : ['销售', '价格表']}
        permanentActions={[
          { label: isEn ? 'New' : '新建', onClick: handleCreate },
          { label: 'Import', onClick: () => toast.info(isEn ? 'Import coming soon' : '导入功能即将推出') },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                { label: 'Mode', onClick: () => setIsReadMode(true) },
              ]),
          ...(selected.size > 0
            ? [{ label: isEn ? `🖨 Print (${selected.size})` : `🖨 打印 (${selected.size})`, onClick: () => {
                const ids = [...selected].join(',')
                window.open(`${prefix}/classic/print/pricelist?ids=${ids}`, '_blank')
              }}]
            : [{ label: isEn ? '🖨 Print All' : '🖨 打印全部', onClick: () => window.open(`${prefix}/classic/print/pricelist`, '_blank') }]
          ),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => { setPage(1) }}
        {...controlPanelProps}
        activeFilters={[
          ...chips,
          ...(selectableFilter ? [{ label: 'Selectable', onRemove: () => setSelectableFilter(false) }] : []),
          ...(activeListFilter ? [{ label: 'Active', onRemove: () => setActiveListFilter(false) }] : []),
        ]}
        filterOptions={[
          { label: 'Selectable', value: 'selectable' },
          { label: 'Active', value: 'active' },
        ]}
        onFilterSelect={v => {
          if (v === 'selectable') setSelectableFilter(prev => !prev)
          else if (v === 'active') setActiveListFilter(prev => !prev)
          setPage(1)
        }}
        groupByOptions={[
          { label: isEn ? 'Currency' : '货币', value: 'currency' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, selectableFilter, activeListFilter, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setSelectableFilter(Boolean(s.selectableFilter))
          setActiveListFilter(Boolean(s.activeListFilter))
          setGroupBy(String(s.groupBy ?? ''))
          setPage(1)
        }}
        storageKey="classic_pricelists_favs"
        total={filteredLists.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => setPage(p)}
      />
      <div className="p-4 overflow-x-auto">
        <OdooTable
          columns={columns}
          rows={pagedLists as unknown as Record<string, unknown>[]}
          loading={loading}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(pagedLists.map(pl => pl.id)))
            else setSelected(new Set())
          }}
          onSelectRow={(id, checked) => {
            setSelected(prev => {
              const next = new Set(prev)
              if (checked) next.add(id)
              else next.delete(id)
              return next
            })
          }}
          onRowClick={row => router.push(`${prefix}/classic/operator/pricelists/${String(row.id)}`)}
          emptyText={isEn ? 'No pricelist data' : '暂无价格表数据'}
          groupByField={groupBy === 'currency' ? 'currency' : ''}
          groupByFormatter={(key, count) => (
            <>{key || (isEn ? '(Empty)' : '（空）')} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({count})</span></>
          )}
          columnFilters={columnFilters}
          onColumnFilterChange={(key, val) => {
            setPage(1)
            setColumnFilters(prev => ({ ...prev, [key]: val }))
          }}
        />
        <Pagination page={page} totalPages={Math.ceil(filteredLists.length / PAGE_SIZE)} onPageChange={setPage} />
      </div>
    </div>
  )
}
