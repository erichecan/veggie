'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import type { PickingWave } from '@/lib/types'
import { WaveStatusBadge } from '@/components/shared/status-badge'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'

const PURPLE = '#875A7B'

function WaveRow({ w, isEn, onClick }: { w: PickingWave; isEn: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const allItems = w.zones.flatMap(z => z.items)
  return (
    <tr
      style={{ background: hover ? '#f3eff5' : undefined, cursor: 'pointer' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <td className="px-4 py-3 font-mono text-xs" style={{ color: PURPLE }}>{w.id.slice(0, 8)}…</td>
      <td className="px-4 py-3 text-center">
        <WaveStatusBadge status={w.status} />
      </td>
      <td className="px-4 py-3 text-center text-gray-600">{(w.orderIds ?? []).length}</td>
      <td className="px-4 py-3 text-center text-gray-600">{allItems.length}</td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {new Date(w.createdAt).toLocaleDateString('en-GB')}
      </td>
      <td className="px-4 py-3 text-center">
        <button className="text-xs hover:underline" style={{ color: PURPLE }} onClick={e => { e.stopPropagation(); onClick() }}>
          {isEn ? 'Sort' : '执行分货'}
        </button>
      </td>
    </tr>
  )
}

const FACET_DEFS: ClientFacetDef<PickingWave>[] = [
  { key: 'name',   label: '波次', labelEn: 'Wave',   values: r => [r.name ?? r.id] },
  { key: 'driver', label: '司机', labelEn: 'Driver', values: r => [r.driverName] },
  { key: 'status', label: '状态', labelEn: 'Status', values: r => [r.status] },
]

export default function ClassicSorterPage() {
  const [waves, setWaves] = useState<PickingWave[]>([])
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<PickingWave[]>('/api/waves')
      setWaves(data.filter(w => ['picked', 'sorting'].includes(w.status.toLowerCase())))
    } catch {
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const { facets, chips, controlPanelProps } = useFacets(localizeClientFacetDefs(FACET_DEFS, isEn))

  const searched = searchInput
    ? waves.filter(w => w.id.toLowerCase().includes(searchInput.toLowerCase()))
    : waves
  const filtered = filterByFacets(searched, facets, FACET_DEFS)

  return (
    <div>
      <OdooControlPanel
        {...controlPanelProps}
        activeFilters={chips}
        breadcrumb={isEn ? ['Warehouse', 'Sorting Tasks'] : ['仓库', '分货任务']}
        permanentActions={[{ label: isEn ? 'Refresh' : '刷新', onClick: load }]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => {}}
        total={filtered.length}
        page={1}
        pageSize={filtered.length || 1}
      />
      <div className="p-4">
        {loading && (
          <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>
        )}
        {!loading && (
          <div className="bg-white border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Wave #' : '波次号'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Orders' : '订单数'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Product Lines' : '商品种数'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Created' : '创建时间'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Action' : '操作'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-16 text-gray-400">{isEn ? 'No sorting tasks' : '暂无分货任务'}</td>
                  </tr>
                )}
                {filtered.map(w => (
                  <WaveRow
                    key={w.id}
                    w={w}
                    isEn={isEn}
                    onClick={() => router.push(`${prefix}/classic/sorter/sort/${w.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
