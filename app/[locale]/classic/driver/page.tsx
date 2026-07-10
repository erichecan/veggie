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
import { formatDateTime } from '@/lib/format-date'

const PURPLE = '#875A7B'

function TripRow({ trip, onClick }: { trip: Trip; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const locale = useLocale()
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
          执行配送
        </button>
      </td>
    </tr>
  )
}

export default function ClassicDriverPage() {
  const [trips, setTrips] = useState<Trip[]>([])
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const router = useRouter()
  const locale = useLocale()
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

  const filtered = searchInput
    ? trips.filter(t => t.id.toLowerCase().includes(searchInput.toLowerCase()))
    : trips

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['配送', '配送任务']}
        permanentActions={[{ label: '刷新', onClick: load }]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => {}}
        total={filtered.length}
        page={1}
        pageSize={filtered.length || 1}
      />
      <div className="p-4">
        {loading && (
          <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">加载中...</div>
        )}
        {!loading && (
          <div className="bg-white border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">行程号</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">状态</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">餐馆数</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">完成进度</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">实收金额</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">出发时间</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-16 text-gray-400">暂无配送任务</td>
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
