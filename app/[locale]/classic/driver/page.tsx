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

function TripCard({ trip, onClick }: { trip: Trip; onClick: () => void }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const restCount = trip.restaurants.length
  // 行程的完成条件与司机端结束按钮一致：站点已送达，或已报告异常。
  // 仅统计 delivered 会让已完成行程（含异常站点）显示为未完成，例如 1/3。
  const processedCount = trip.restaurants.filter(r => r.delivered || (r.returns ?? []).length > 0).length
  const amountCollected = trip.restaurants.reduce((sum, restaurant) => sum + (restaurant.payment ?? 0), 0)
  return (
    <article className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500">{isEn ? 'Trip #' : '行程号'}</p>
          <h2 className="mt-1 break-words text-base font-bold text-gray-900 sm:text-lg">
            {trip.name || `Trip · ${trip.id.slice(-6).toUpperCase()}`}
          </h2>
        </div>
        <div className="shrink-0"><TripStatusBadge status={trip.status} /></div>
      </div>
      <dl className="px-4 sm:px-5">
        {[
          [isEn ? 'Restaurants' : '餐馆数', String(restCount)],
          [isEn ? 'Progress' : '完成进度', `${processedCount} / ${restCount}`],
          [isEn ? 'Amount Collected' : '实收金额', `€${amountCollected.toFixed(2)}`],
          [isEn ? 'Start Time' : '出发时间', trip.departTime ? formatDateTime(trip.departTime) : '—'],
        ].map(([label, value], index) => (
          <div key={label} className={`flex min-h-14 items-center justify-between gap-3 py-3 ${index < 3 ? 'border-b border-gray-100' : ''}`}>
            <dt className="shrink-0 text-sm font-medium text-gray-500">{label}</dt>
            <dd className="min-w-0 max-w-[65%] break-words text-right text-sm font-semibold text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="px-4 pb-4 pt-1 sm:px-5 sm:pb-5">
        <button
          type="button"
          onClick={onClick}
          className="min-h-12 w-full rounded-lg px-4 text-base font-semibold text-white shadow-sm transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#875A7B]"
          style={{ background: PURPLE }}
        >
          {isEn ? 'View Orders' : '查看订单'}
        </button>
      </div>
    </article>
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

  const { facets, chips, controlPanelProps, clear: clearFacets } = useFacets(localizeClientFacetDefs(FACET_DEFS, isEn))

  // 一键清除（20261017 客户反馈“清不掉筛选条件”）
  function clearAllFilters() {
    setSearchInput('')
    clearFacets()
  }

  const searched = searchInput
    ? trips.filter(t => t.id.toLowerCase().includes(searchInput.toLowerCase()) || (t.name ?? '').toLowerCase().includes(searchInput.toLowerCase()))
    : trips
  const filtered = filterByFacets(searched, facets, FACET_DEFS)
  const activeTrips = trips.filter(t => String(t.status).toLowerCase() === 'in_progress')

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
        onClearAll={clearAllFilters}
        total={filtered.length}
        page={1}
        pageSize={filtered.length || 1}
      />
      <div className="mx-auto max-w-3xl px-0 py-2 sm:px-2 sm:py-3">
        {!loading && activeTrips.length > 0 && (
          <section role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
            <h2 className="font-semibold">
              {isEn
                ? `${activeTrips.length} trip${activeTrips.length === 1 ? '' : 's'} currently in delivery`
                : `当前有 ${activeTrips.length} 个行程正在配送`}
            </h2>
            <p className="mt-1 text-sm leading-relaxed">
              {isEn
                ? 'Finish and close the active trip before confirming departure for another trip.'
                : '请先完成并关闭正在配送的行程，再确认其他行程出发。'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {activeTrips.map(activeTrip => (
                <button
                  key={activeTrip.id}
                  type="button"
                  onClick={() => router.push(`${prefix}/classic/driver/trip/${activeTrip.id}`)}
                  className="min-h-10 rounded-lg border border-amber-400 bg-white px-3 py-2 text-left text-sm font-semibold text-amber-950 hover:bg-amber-100"
                >
                  {activeTrip.name || activeTrip.id} · {activeTrip.id.slice(-6).toUpperCase()}
                </button>
              ))}
            </div>
          </section>
        )}
        {loading && (
          <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-gray-400">
            {isEn ? 'No delivery tasks' : '暂无配送任务'}
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="space-y-4">
            {filtered.map(trip => (
              <TripCard
                key={trip.id}
                trip={trip}
                onClick={() => router.push(`${prefix}/classic/driver/trip/${trip.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
