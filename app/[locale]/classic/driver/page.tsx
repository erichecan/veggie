'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { getSession } from '@/lib/session'
import type { Trip } from '@/lib/types'
import { TripStatusBadge } from '@/components/shared/status-badge'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'
import { formatDateTime } from '@/lib/format-date'

const PURPLE = '#875A7B'

function TripRow({ trip, onClick }: { trip: Trip; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const restCount = trip.restaurants.length
  const deliveredCount = trip.restaurants.filter(r => r.delivered).length
  return (
    <tr
      style={{ background: hover ? '#f3eff5' : undefined, cursor: 'pointer' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <td className="px-4 py-3 font-mono text-xs" style={{ color: PURPLE }}>{trip.id.slice(0, 8)}…</td>
      <td className="px-4 py-3 text-center">
        <TripStatusBadge status={trip.status} />
      </td>
      <td className="px-4 py-3 text-center text-gray-600">{restCount}</td>
      <td className="px-4 py-3 text-center text-gray-600">{deliveredCount} / {restCount}</td>
      <td className="px-4 py-3 text-center text-gray-600">
        {trip.totalPayment > 0 ? `€${trip.totalPayment.toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {trip.departTime ? formatDateTime(trip.departTime) : '—'}
      </td>
      <td className="px-4 py-3 text-center">
        <button className="text-xs hover:underline" style={{ color: PURPLE }} onClick={e => { e.stopPropagation(); onClick() }}>
          {isEn ? 'Start Delivery' : '执行配送'}
        </button>
      </td>
    </tr>
  )
}

const FACET_DEFS: ClientFacetDef<Trip>[] = [
  { key: 'name',   label: '行程', labelEn: 'Trip',   values: r => [r.name ?? r.id] },
  { key: 'driver', label: '司机', labelEn: 'Driver', values: r => [r.driverName] },
  { key: 'slot',   label: '时段', labelEn: 'Slot',   values: r => [r.timeSlot] },
  { key: 'status', label: '状态', labelEn: 'Status', values: r => [r.status] },
]

export default function ClassicDriverPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  async function load() {
    setLoading(true)
    try {
      const user = getSession()
      if (!user) return
      const data = await apiGet<Trip[]>(`/api/trips?driverId=${user.userId}`)
      setTrips(data)
    } catch {
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const { facets, chips, controlPanelProps } = useFacets(localizeClientFacetDefs(FACET_DEFS, isEn))

  const searched = searchInput
    ? trips.filter(t => t.id.toLowerCase().includes(searchInput.toLowerCase()))
    : trips
  const filtered = filterByFacets(searched, facets, FACET_DEFS)

  return (
    <div>
      <OdooControlPanel
        {...controlPanelProps}
        activeFilters={chips}
        breadcrumb={isEn ? ['Delivery', 'Delivery Tasks'] : ['配送', '配送任务']}
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
                  <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Trip #' : '行程号'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Restaurants' : '餐馆数'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Progress' : '完成进度'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Amount Collected' : '实收金额'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Departure Time' : '出发时间'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Action' : '操作'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-16 text-gray-400">{isEn ? 'No delivery tasks' : '暂无配送任务'}</td>
                  </tr>
                )}
                {filtered.map(trip => (
                  <TripRow
                    key={trip.id}
                    trip={trip}
                    onClick={() => router.push(`${prefix}/classic/driver/trip/${trip.id}`)}
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
