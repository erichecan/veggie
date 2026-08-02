'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { OdooPricelist } from '@/lib/types'
import { formatDateTime } from '@/lib/format-date'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, type ClientFacetDef } from '@/lib/facet-client'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'

const PAGE_SIZE = 80

const FACET_DEFS: ClientFacetDef<OdooPricelist>[] = [
  { key: 'name',     label: '名称', values: r => [r.name] },
  { key: 'currency', label: '货币', values: r => [r.currency] },
  // 不做「商品」维度：OdooPricelistItem 只存 productTemplateId/productVariantId，
  // 没有商品名，按名字搜必然搜不到（同 barcode 的处理原则）。
  // 若要支持，需在页面里先加载 id→名称 映射再匹配，属独立改动。
]

export default function ClassicPricelistsPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [lists, setLists] = useState<OdooPricelist[]>([])
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  const [isReadMode, setIsReadMode] = useState(true)
  const [page, setPage] = useState(1)
  const [selectableFilter, setSelectableFilter] = useState(false)
  const [activeListFilter, setActiveListFilter] = useState(false)
  const [groupBy, setGroupBy] = useState('')

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<OdooPricelist[]>('/api/pricelists')
      setLists([...data].sort((a, b) => a.sequence - b.sequence))
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

  const { facets, chips, controlPanelProps } = useFacets(FACET_DEFS.map(d => ({ key: d.key, label: d.label })))

  const filteredLists = useMemo(() => {
    let rows = filterByFacets(lists, facets, FACET_DEFS)
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
  }, [lists, searchInput, columnFilters, selectableFilter, activeListFilter])

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
