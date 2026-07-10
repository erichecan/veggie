'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { PickingWave, WaveStatus } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import { sortRows, type SortDir } from '@/components/shared/sort-th'
import { DAY_ABBR, DAY_COLORS, formatDateTime } from '@/lib/format-date'

const STATUS_LABEL: Record<WaveStatus, string> = {
  pending:  '待拣货',
  picking:  '拣货中',
  picked:   '拣货完成',
  sorting:  '分货中',
  sorted:   '已分货',
}
const STATUS_COLOR: Record<WaveStatus, string> = {
  pending:  'bg-gray-100 text-gray-600',
  picking:  'bg-blue-50 text-blue-700',
  picked:   'bg-cyan-50 text-cyan-700',
  sorting:  'bg-purple-50 text-purple-700',
  sorted:   'bg-green-50 text-green-700',
}

// 分货页只显示 picked / sorting 状态的波次
const SORTING_STATUSES: WaveStatus[] = ['picked', 'sorting']

export default function ClassicSortingPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [waves, setWaves] = useState<PickingWave[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<WaveStatus | ''>('')
  const [sortKey, setSortKey] = useState('createdAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<Record<string, unknown>[]>('/api/waves')
      const normalized: PickingWave[] = data
        .map(w => ({
          ...(w as unknown as PickingWave),
          status: (w.status as string).toLowerCase() as WaveStatus,
          zones: (w.zones as PickingWave['zones']) ?? [],
          orderIds: (w.orderIds as string[]) ?? [],
        }))
        .filter(w => SORTING_STATUSES.includes(w.status))
      setWaves(normalized)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const base = waves.filter(w => {
      const matchStatus = statusFilter ? w.status === statusFilter : true
      const matchSearch = searchInput
        ? (w.name ?? w.id).toLowerCase().includes(searchInput.toLowerCase())
        : true
      return matchStatus && matchSearch
    })
    return sortRows(base, sortKey, sortDir)
  }, [waves, statusFilter, searchInput, sortKey, sortDir])

  function removeStatusFilter() {
    setStatusFilter('')
  }

  const activeFilters = statusFilter
    ? [{ label: `状态：${STATUS_LABEL[statusFilter]}`, onRemove: removeStatusFilter }]
    : []

  const columns: OdooColumn[] = [
    {
      key: 'name',
      label: '波次编号',
      render: (_, row) => {
        const name = row.name ? String(row.name) : null
        if (!name) return <span className="font-mono text-xs" style={{ color: '#875A7B' }}>{String(row.id).slice(0, 8)}…</span>
        const parts = name.split(' ')
        const dayIdx = DAY_ABBR.indexOf(parts[1] as typeof DAY_ABBR[number])
        return (
          <span className="font-mono text-xs">
            <span style={{ color: '#875A7B' }}>{parts[0]}</span>{' '}
            <strong style={{ color: dayIdx >= 0 ? DAY_COLORS[dayIdx] : '#875A7B', fontWeight: 700 }}>{parts[1]}</strong>{' '}
            <span style={{ color: '#875A7B' }}>{parts[2]}</span>
          </span>
        )
      },
    },
    {
      key: 'createdAt',
      label: '创建时间',
      sortable: true,
      render: (v) => (
        <span className="text-xs text-gray-500">
          {formatDateTime(String(v))}
        </span>
      ),
    },
    {
      key: 'orderIds',
      label: '订单数',
      render: (_, row) => (
        <span className="font-medium">{(row.orderIds as unknown[]).length}</span>
      ),
    },
    {
      key: 'zones',
      label: '商品种类',
      render: (_, row) => (
        <span>
          {(row.zones as Array<{ items: unknown[] }>).reduce(
            (s, z) => s + z.items.length,
            0,
          )}
        </span>
      ),
    },
    {
      key: 'status',
      label: '状态',
      sortable: true,
      render: (v) => (
        <span
          className={`inline-block px-2 py-0.5 rounded text-xs ${
            STATUS_COLOR[v as WaveStatus] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {STATUS_LABEL[v as WaveStatus] ?? String(v)}
        </span>
      ),
    },
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['仓库', '分货']}
        permanentActions={[{ label: '刷新', onClick: load }]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => {}}
        activeFilters={activeFilters}
        filterOptions={[
          { label: '拣货完成', value: 'picked' },
          { label: '分货中',   value: 'sorting' },
        ]}
        onFilterSelect={v => setStatusFilter(v as WaveStatus)}
        total={filtered.length}
        page={1}
        pageSize={filtered.length || 1}
      />
      <div className="p-4">
        <OdooTable
          columns={columns}
          rows={filtered as unknown as Record<string, unknown>[]}
          loading={loading}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={key => {
            if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
            else { setSortKey(key); setSortDir('asc') }
          }}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(filtered.map(w => w.id)))
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
          onRowClick={row => router.push(`${prefix}/classic/operator/sorting/${row.id}`)}
          emptyText="暂无待分货的波次（需要拣货员先完成拣货）"
        />
      </div>
    </div>
  )
}
