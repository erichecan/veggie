'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { OdooPricelist, Product } from '@/lib/types'
import { formatDateTime } from '@/lib/format-date'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'
import type { Facet } from '@/lib/list-filters'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { useCsvExport } from '@/hooks/use-csv-export'
import { PRICELIST_EXPORT_COLUMNS } from '@/lib/export/columns/pricelists'
import { pricelistImportColumns, PRICELIST_IMPORT_EXAMPLE_ROWS } from './pricelist-import-columns'

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
  tab: 'active' | 'archived'
  groupBy: string
  page: number
  sortKey: string
  sortDir: 'asc' | 'desc'
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
  const editMode = !isReadMode
  const [page, setPage] = useState(saved?.page ?? 1)
  const [selectableFilter, setSelectableFilter] = useState(saved?.selectableFilter ?? false)
  // 使用中/已停用分开两个 Tab，不再靠一个"Active"筛选开关把已归档价格表混进同一张表——
  // 20260924 用户反馈"archived 的价格表要单独归一个界面"。
  const [tab, setTab] = useState<'active' | 'archived'>(saved?.tab ?? 'active')
  const [groupBy, setGroupBy] = useState(saved?.groupBy ?? '')
  const [sortKey, setSortKey] = useState(saved?.sortKey ?? '')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(saved?.sortDir ?? 'asc')
  const [importOpen, setImportOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  function handleTabChange(next: 'active' | 'archived') {
    setTab(next)
    setPage(1)
    setSelected(new Set())
  }

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

  // 价格表/商品管理在别的 tab 改了数据后，切回这个已打开的列表页希望看到最新结果
  useRefetchOnFocus([load])

  function handleCreate() {
    // 详情页会以本地草稿态展示，真正落库推迟到用户点 Save，
    // 避免"点了新建但没填名字就退出"在库里留下永久空名孤儿记录。
    router.push(`${prefix}/classic/operator/pricelists/new`)
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
    const state: SavedListState = { searchInput, facets, columnFilters, selectableFilter, tab, groupBy, page, sortKey, sortDir }
    try { sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify(state)) } catch { /* 存储不可用时静默跳过,不影响筛选本身 */ }
  }, [searchInput, facets, columnFilters, selectableFilter, tab, groupBy, page, sortKey, sortDir])

  const filteredLists = useMemo(() => {
    let rows = filterByFacets(lists, facets, facetDefs)
    rows = rows.filter(pl => pl.active === (tab === 'active'))
    if (searchInput) {
      rows = rows.filter(pl => pl.name.toLowerCase().includes(searchInput.toLowerCase()))
    }
    if (selectableFilter) rows = rows.filter(pl => pl.selectable)
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
  }, [lists, facets, facetDefs, tab, searchInput, columnFilters, selectableFilter])

  // 点列头排序前，列表恒按 sequence（后端存的任意顺序）展示——名称一栏看着大小写
  // 随机混排、Last Updated on 一栏也不按时间先后，就是因为从没真正排过序
  // （20261002 客户反馈截图）。name 用 localeCompare + sensitivity:'base' 做大小写
  // 不敏感比较，updatedAt 按真实时间戳比较，不是字符串字典序。
  const sortedLists = useMemo(() => {
    if (!sortKey) return filteredLists
    const dir = sortDir === 'asc' ? 1 : -1
    const rows = [...filteredLists]
    rows.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir
      if (sortKey === 'updatedAt') return (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * dir
      return 0
    })
    return rows
  }, [filteredLists, sortKey, sortDir])

  // 勾选只认当前筛选下看得见的行(同客户/商品列表，20261008)：换了 Tab/筛选后，之前勾的
  // 隐藏行不能被批量操作带上
  const visibleSelected = useMemo(() => {
    const visible = new Set(filteredLists.map(pl => pl.id))
    return new Set([...selected].filter(id => visible.has(id)))
  }, [selected, filteredLists])
  const exportAction = useCsvExport({
    entity: 'pricelists',
    params: () => (visibleSelected.size > 0 ? `ids=${[...visibleSelected].map(encodeURIComponent).join(',')}` : ''),
    columns: PRICELIST_EXPORT_COLUMNS,
  })

  /** 批量归档 / 取消归档：逐条 PUT active，失败的单独报出来 */
  async function setActiveSelected(active: boolean) {
    const targets = lists.filter(pl => visibleSelected.has(pl.id))
    if (targets.length === 0 || batchBusy) return
    const msg = active
      ? (isEn ? `Unarchive ${targets.length} pricelist(s)?` : `确认恢复 ${targets.length} 个价格表？`)
      : (isEn ? `Archive ${targets.length} pricelist(s)? Customers keep their links; archived pricelists can be restored from the Archived tab.` : `确认归档 ${targets.length} 个价格表？客户上的挂靠不变，可在「已停用」里恢复。`)
    if (!confirm(msg)) return
    setBatchBusy(true)
    const failed: string[] = []
    for (const pl of targets) {
      try { await apiPut(`/api/pricelists/${pl.id}`, { active }) } catch { failed.push(pl.name) }
    }
    setBatchBusy(false)
    setSelected(new Set())
    if (failed.length) toast.error(isEn ? `Failed: ${failed.join(', ')}` : `失败：${failed.join('、')}`)
    else toast.success(active ? (isEn ? `Unarchived ${targets.length}` : `已恢复 ${targets.length} 个`) : (isEn ? `Archived ${targets.length}` : `已归档 ${targets.length} 个`))
    load()
  }

  /** 批量复制：名称加 (copy)，规则整份复制并换新的规则 id；不复制 externalId(唯一)和客户挂靠 */
  async function duplicateSelected() {
    const targets = lists.filter(pl => visibleSelected.has(pl.id))
    if (targets.length === 0 || batchBusy) return
    setBatchBusy(true)
    const failed: string[] = []
    for (const pl of targets) {
      try {
        await apiPost('/api/pricelists', {
          name: `${pl.name} (copy)`,
          currency: pl.currency,
          sequence: pl.sequence,
          selectable: pl.selectable,
          active: true,
          notes: (pl as unknown as { notes?: string | null }).notes ?? null,
          // 去掉规则 id，服务端重新生成——副本和原表的规则 id 不能相同(导入按 Item ID 定位规则)
          items: (pl.items ?? []).map(({ id: _id, ...it }) => it),
        })
      } catch { failed.push(pl.name) }
    }
    setBatchBusy(false)
    setSelected(new Set())
    if (failed.length) toast.error(isEn ? `Failed: ${failed.join(', ')}` : `失败：${failed.join('、')}`)
    else toast.success(isEn ? `Duplicated ${targets.length} pricelist(s)` : `已复制 ${targets.length} 个价格表`)
    if (tab !== 'active') setTab('active')
    load()
  }

  const pagedLists = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return sortedLists.slice(start, start + PAGE_SIZE)
  }, [sortedLists, page])

  async function handleCellEdit(row: Record<string, unknown>, key: string, newValue: unknown) {
    const pl = row as unknown as OdooPricelist
    const payloadVal = key === 'name' ? String(newValue).trim() : newValue
    if (key === 'name' && !payloadVal) {
      toast.error(isEn ? 'Name cannot be empty' : '名称不能为空')
      throw new Error('empty name')
    }
    try {
      await apiPut(`/api/pricelists/${pl.id}`, { [key]: payloadVal })
      setLists(prev => prev.map(row => row.id === pl.id ? { ...row, [key]: payloadVal } as OdooPricelist : row))
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      throw e
    }
  }

  const columns: OdooColumn[] = [
    {
      key: 'name',
      label: 'Pricelist Name',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'text',
      render: (v, row) => {
        const pl = row as unknown as OdooPricelist
        return (
          <span className="font-medium" style={{ color: '#875A7B' }}>
            {pl.name || <span className="text-gray-400 italic">{isEn ? '(Unnamed)' : '（未命名）'}</span>}
          </span>
        )
      },
    },
    {
      key: 'updatedAt',
      label: 'Last Updated on',
      filterType: 'date-range',
      sortable: true,
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
      editable: true,
      editType: 'text',
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
      <div className="flex gap-2 px-4 pt-3 pb-1 flex-wrap bg-gray-50">
        {(['active', 'archived'] as const).map(t => {
          const on = tab === t
          return (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border bg-white hover:shadow-sm transition-all"
              style={on ? { borderColor: '#875A7B', color: '#875A7B', background: '#f3eff5' } : { borderColor: '#e5e7eb', color: '#6b7280' }}
            >
              {t === 'active' ? (isEn ? 'Active' : '使用中') : (isEn ? 'Archived' : '已停用')}
            </button>
          )
        })}
      </div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Pricelists'] : ['销售', '价格表']}
        permanentActions={[
          { label: isEn ? 'New' : '新建', onClick: handleCreate },
          { label: 'Import', onClick: () => setImportOpen(true) },
          { label: visibleSelected.size > 0 ? (isEn ? `Export (${visibleSelected.size})` : `导出所选 (${visibleSelected.size})`) : exportAction.label, onClick: exportAction.onClick, disabled: exportAction.disabled },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                { label: 'Mode', onClick: () => setIsReadMode(true) },
              ]),
          ...(visibleSelected.size > 0
            ? [{ label: isEn ? `🖨 Print (${visibleSelected.size})` : `🖨 打印 (${visibleSelected.size})`, onClick: () => {
                const ids = [...visibleSelected].join(',')
                window.open(`${prefix}/classic/print/pricelist?ids=${ids}`, '_blank')
              }}]
            : [{ label: isEn ? '🖨 Print All' : '🖨 打印全部', onClick: () => window.open(`${prefix}/classic/print/pricelist`, '_blank') }]
          ),
        ]}
        actions={visibleSelected.size > 0 ? [
          { label: isEn ? `Duplicate (${visibleSelected.size})` : `复制 (${visibleSelected.size})`, onClick: duplicateSelected, disabled: batchBusy },
          tab === 'active'
            ? { label: isEn ? `Archive (${visibleSelected.size})` : `归档 (${visibleSelected.size})`, onClick: () => setActiveSelected(false), disabled: batchBusy }
            : { label: isEn ? `Unarchive (${visibleSelected.size})` : `恢复 (${visibleSelected.size})`, onClick: () => setActiveSelected(true), disabled: batchBusy },
        ] : []}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => { setPage(1) }}
        {...controlPanelProps}
        activeFilters={[
          ...chips,
          ...(selectableFilter ? [{ label: 'Selectable', onRemove: () => setSelectableFilter(false) }] : []),
        ]}
        filterOptions={[
          { label: 'Selectable', value: 'selectable' },
        ]}
        onFilterSelect={v => {
          if (v === 'selectable') setSelectableFilter(prev => !prev)
          setPage(1)
        }}
        groupByOptions={[
          { label: isEn ? 'Currency' : '货币', value: 'currency' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, selectableFilter, tab, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setSelectableFilter(Boolean(s.selectableFilter))
          setTab(s.tab === 'archived' ? 'archived' : 'active')
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
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={key => {
            if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
            else { setSortKey(key); setSortDir('asc') }
            setPage(1)
          }}
          selected={visibleSelected}
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
          inlineEditEnabled={editMode}
          onCellEdit={handleCellEdit}
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

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={load}
        templateFileName="pricelists-import-template"
        endpoint="/api/pricelists/bulk" historyResource="pricelist"
        title={{ zh: '批量导入价格表(CSV)', en: 'Bulk Import Pricelists (CSV)' }}
        hint={{
          zh: '第一行为表头。列名与价格表导出完全一致，导出的 CSV 改完可直接重新导入。一行 = 一条定价规则，同一个价格表的规则要把「价格表名称」填在每一行上。仅「价格表名称」必填。',
          en: 'Row 1 is the header. Columns match the pricelist export exactly, so an exported CSV can be edited and re-imported. One row = one pricing rule; fill in Pricelist Name on every row for the same pricelist. Pricelist Name is the only required column.',
        }}
        extraHint={{
          zh: <>按「ID → 名称」匹配已有价格表(都没匹配上则新建)。商品优先按<b>商品编号</b>匹配，没填再按商品名称。<b>规则 ID</b>(Item ID)是系统给每条定价规则的内部编号，只用来定位要改哪一条，请原样保留、不用看懂;留空 = 新增一条规则;填了且匹配到已有规则 = 原地替换那一条。⛔ 不支持删除已有规则，导入只会新增/更新，不会清空。「适用范围」留空 = 这一行只改价格表本身的设置(名称/币种/启用/可选/排序)，不带规则。</>,
          en: <>Matched by ID → Name (no match creates a new pricelist). Products are matched by <b>Product No</b> first, then by product name. <b>Item ID</b> is the system&apos;s internal id of each pricing rule — it only tells the import which rule to update, so keep it as exported. Leave Item ID blank to add a new rule; fill a matching existing Item ID to replace that rule in place. ⛔ Deleting existing rules via CSV is not supported — import only adds/updates, never clears. Leave Apply On blank for a row that only updates the pricelist&apos;s own settings (name/currency/active/selectable/sequence), with no rule attached.</>,
        }}
        columns={pricelistImportColumns(isEn)}
        exampleRows={PRICELIST_IMPORT_EXAMPLE_ROWS}
      />
      {exportAction.dialog}
    </div>
  )
}
