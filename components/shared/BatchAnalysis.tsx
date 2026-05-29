'use client'
import { useState, useCallback, useMemo, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { apiGet, apiPost } from '@/lib/api'
import { getBatchColor, computeConvexHull, type MapMarker, type ConvexHullGroup } from './BatchMap'

const BatchMap = dynamic(() => import('./BatchMap'), {
  ssr: false,
  loading: () => (
    <div className="h-[520px] rounded-lg border bg-gray-50 flex items-center justify-center text-sm text-gray-400">
      加载地图…
    </div>
  ),
})

// ── Interfaces ──────────────────────────────────────────────────────────────

interface Restaurant {
  id: string
  name: string
  latitude?: number | null
  longitude?: number | null
  address?: string
}

interface BatchGroup {
  batchLabel: string
  batchIndex: number
  restaurants: Restaurant[]
}

interface RouteInfo {
  totalDistanceKm: number
  totalDurationMin: number
  summary: string
  legs: { from: string; to: string; distance: string; duration: string }[]
}

type WorkloadLevel = 'easy' | 'mid' | 'heavy'

function getWorkload(km: number, min: number): WorkloadLevel {
  if (km > 60 || min > 120) return 'heavy'
  if (km > 30 || min > 60) return 'mid'
  return 'easy'
}

const WORKLOAD_LABEL: Record<WorkloadLevel, string> = { easy: '轻松', mid: '中等', heavy: '偏重' }
const WORKLOAD_STYLE: Record<WorkloadLevel, string> = {
  easy: 'bg-green-100 text-green-800',
  mid: 'bg-amber-100 text-amber-800',
  heavy: 'bg-red-100 text-red-800',
}

function formatDuration(min: number): string {
  if (min < 60) return `${Math.round(min)} min`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m > 0 ? `${h} h ${m} min` : `${h} h`
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function BatchAnalysis() {
  // Data
  const [batches, setBatches] = useState<BatchGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [routeInfoMap, setRouteInfoMap] = useState<Record<number, RouteInfo>>({})

  // Bulk calculation
  const [calcProgress, setCalcProgress] = useState<{ current: number; total: number } | null>(null)
  const [calcDone, setCalcDone] = useState(false)

  // Geocode
  const [geocoding, setGeocoding] = useState(false)

  // Map visibility
  const [hiddenBatches, setHiddenBatches] = useState<Set<number>>(new Set())

  // Card leg expansion
  const [expandedLegs, setExpandedLegs] = useState<Set<number>>(new Set())

  // ── Fetch batch data ───────────────────────────────────────────────────────
  const fetchBatches = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<BatchGroup[]>('/api/batch-analysis')
      setBatches(data)
    } catch {
      // Error handled by apiGet (toast/redirect)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchBatches() }, [fetchBatches])

  // ── Markers + convex hulls ─────────────────────────────────────────────────
  const { allMarkers, convexHulls } = useMemo(() => {
    const markers: MapMarker[] = []
    const hulls: ConvexHullGroup[] = []

    batches.forEach((batch) => {
      const color = getBatchColor(batch.batchIndex)
      const validPts: { lat: number; lng: number }[] = []
      let markerNum = 0

      batch.restaurants.forEach((r) => {
        if (r.latitude && r.longitude) {
          markerNum++
          markers.push({
            lat: r.latitude,
            lng: r.longitude,
            label: r.name,
            color,
            popup: batch.batchLabel,
            batchIndex: batch.batchIndex,
            markerNumber: markerNum,
          })
          validPts.push({ lat: r.latitude, lng: r.longitude })
        }
      })

      if (validPts.length >= 3) {
        const hull = computeConvexHull(validPts)
        hulls.push({ batchIndex: batch.batchIndex, points: hull, color })
      }
    })

    return { allMarkers: markers, convexHulls: hulls }
  }, [batches])

  // ── Missing coordinates ────────────────────────────────────────────────────
  const missingCoords = useMemo(() => {
    return batches.flatMap(b =>
      b.restaurants
        .filter(r => !r.latitude || !r.longitude)
        .map(r => ({ ...r, batch: b.batchLabel }))
    )
  }, [batches])

  const handleGeocode = useCallback(async () => {
    if (missingCoords.length === 0) return
    setGeocoding(true)
    try {
      await apiPost('/api/geocode', { customerIds: missingCoords.map(r => r.id) })
      await fetchBatches()
    } catch {
      // silent
    } finally {
      setGeocoding(false)
    }
  }, [missingCoords, fetchBatches])

  // ── Bulk route calculation ─────────────────────────────────────────────────
  const calculateAllRoutes = useCallback(async () => {
    const eligible = batches.filter(b => {
      const withCoords = b.restaurants.filter(r => r.latitude && r.longitude)
      return withCoords.length >= 2
    })
    if (eligible.length === 0) return

    setCalcProgress({ current: 0, total: eligible.length })
    setCalcDone(false)

    for (let i = 0; i < eligible.length; i++) {
      const batch = eligible[i]
      const customerIds = batch.restaurants
        .filter(r => r.latitude && r.longitude)
        .map(r => r.id)
      try {
        const result = await apiPost<RouteInfo>('/api/distance-matrix', { customerIds })
        setRouteInfoMap(prev => ({ ...prev, [batch.batchIndex]: result }))
      } catch {
        // skip failed batch, continue
      }
      setCalcProgress({ current: i + 1, total: eligible.length })
    }

    setCalcDone(true)
    setCalcProgress(null)
  }, [batches])

  // ── Toggle legend visibility ───────────────────────────────────────────────
  const toggleBatch = useCallback((batchIndex: number) => {
    setHiddenBatches(prev => {
      const next = new Set(prev)
      if (next.has(batchIndex)) next.delete(batchIndex)
      else next.add(batchIndex)
      return next
    })
  }, [])

  // ── Overview table data (sorted heavy→easy) ────────────────────────────────
  const overviewRows = useMemo(() => {
    const rows = batches.map(b => {
      const route = routeInfoMap[b.batchIndex]
      const km = route?.totalDistanceKm ?? 0
      const min = route?.totalDurationMin ?? 0
      const restaurantCount = b.restaurants.length
      const avgKm = restaurantCount > 1 ? km / (restaurantCount - 1) : 0
      const workload = route ? getWorkload(km, min) : null
      return { batch: b, route, km, min, avgKm, restaurantCount, workload }
    })

    // Only include batches that have route data in sorted section
    const withRoute = rows.filter(r => r.route)
    const withoutRoute = rows.filter(r => !r.route)

    // Sort: heavy → mid → easy
    const order: Record<WorkloadLevel, number> = { heavy: 0, mid: 1, easy: 2 }
    withRoute.sort((a, b) => order[a.workload!] - order[b.workload!])

    return [...withRoute, ...withoutRoute]
  }, [batches, routeInfoMap])

  const avgDistance = useMemo(() => {
    const withRoute = overviewRows.filter(r => r.route)
    if (withRoute.length === 0) return 0
    return withRoute.reduce((s, r) => s + r.km, 0) / withRoute.length
  }, [overviewRows])

  const avgDuration = useMemo(() => {
    const withRoute = overviewRows.filter(r => r.route)
    if (withRoute.length === 0) return 0
    return withRoute.reduce((s, r) => s + r.min, 0) / withRoute.length
  }, [overviewRows])

  const avgRestaurants = useMemo(() => {
    if (batches.length === 0) return 0
    return batches.reduce((s, b) => s + b.restaurants.length, 0) / batches.length
  }, [batches])

  const hasAnyRoute = Object.keys(routeInfoMap).length > 0

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
        加载批次数据中…
      </div>
    )
  }

  if (batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400 text-sm gap-2">
        <span className="text-3xl">📭</span>
        无批次数据
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ═══ ACTION BAR (sticky) ═══ */}
      <div className="sticky top-0 z-40 bg-white border-b px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-800">批次路线分析</h1>
        <div className="flex items-center gap-3">
          {calcProgress && (
            <div className="flex items-center gap-3">
              <div className="w-40 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{ width: `${(calcProgress.current / calcProgress.total) * 100}%` }}
                />
              </div>
              <span className="text-sm text-gray-500">
                正在计算 {calcProgress.current}/{calcProgress.total} 批次…
              </span>
            </div>
          )}
          <button
            onClick={calculateAllRoutes}
            disabled={!!calcProgress}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition"
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 17V7m0 10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m0 10a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m0 10V7m0 10a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2" />
            </svg>
            {calcDone ? '重新计算所有路线' : '计算所有路线'}
          </button>
          <button
            onClick={() => { setRouteInfoMap({}); setCalcDone(false); fetchBatches() }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 transition"
          >
            <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M4 4v5h5M20 20v-5h-5" />
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L4 4m16 16l-1.64-1.64A9 9 0 0 1 3.51 15" />
            </svg>
            刷新数据
          </button>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
        {/* ═══ MISSING COORDS BANNER ═══ */}
        {missingCoords.length > 0 && (
          <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5">
            <div className="text-sm text-amber-800">
              <span className="font-semibold">{missingCoords.length} 家餐馆缺少坐标</span>
              <span className="ml-1 text-amber-700">
                — 无法参与路线计算：
                {missingCoords.slice(0, 5).map(r => `${r.name} (${r.batch})`).join('、')}
                {missingCoords.length > 5 && `…等 ${missingCoords.length} 家`}
              </span>
            </div>
            <button
              onClick={handleGeocode}
              disabled={geocoding}
              className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition"
            >
              {geocoding ? '解析中…' : '自动解析地址'}
            </button>
          </div>
        )}

        {/* ═══ MAP SECTION ═══ */}
        {allMarkers.length > 0 && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
              <h2 className="text-base font-semibold">配送地图</h2>
              <div className="flex gap-1.5 flex-wrap">
                {batches.map(b => {
                  const isHidden = hiddenBatches.has(b.batchIndex)
                  const withCoords = b.restaurants.filter(r => r.latitude && r.longitude).length
                  return (
                    <button
                      key={b.batchIndex}
                      onClick={() => toggleBatch(b.batchIndex)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[13px] cursor-pointer select-none border transition ${
                        isHidden
                          ? 'opacity-35 border-transparent'
                          : 'border-transparent hover:bg-gray-50'
                      }`}
                    >
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getBatchColor(b.batchIndex) }}
                      />
                      <span>{b.batchLabel}</span>
                      <span className="text-gray-400 text-xs">{withCoords}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <BatchMap
              markers={allMarkers}
              height="520px"
              convexHulls={convexHulls}
              hiddenBatches={hiddenBatches}
            />
          </div>
        )}

        {/* ═══ OVERVIEW TABLE ═══ */}
        {hasAnyRoute && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
              <h2 className="text-base font-semibold">批次对比总览</h2>
              <span className="text-[13px] text-gray-400">按工作量从高到低排列</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 text-left text-[13px] font-semibold text-gray-500">
                    <th className="px-4 py-3 min-w-[200px]">批次</th>
                    <th className="px-4 py-3">餐馆数</th>
                    <th className="px-4 py-3">总距离</th>
                    <th className="px-4 py-3">预计时间</th>
                    <th className="px-4 py-3">平均/站</th>
                    <th className="px-4 py-3">工作量</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {overviewRows.map(row => {
                    const isWarn = row.route && avgDistance > 0 && row.km > avgDistance * 2
                    return (
                      <tr
                        key={row.batch.batchIndex}
                        className={isWarn ? 'bg-red-50' : ''}
                      >
                        <td className="px-4 py-3.5 border-b border-gray-100">
                          <div className="flex items-center gap-2 font-semibold">
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: getBatchColor(row.batch.batchIndex) }}
                            />
                            {row.batch.batchLabel}
                            {isWarn && (
                              <span className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded bg-red-50 text-red-600 text-xs font-semibold">
                                距离超平均 2x
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 border-b border-gray-100">{row.restaurantCount}</td>
                        <td className="px-4 py-3.5 border-b border-gray-100">
                          {row.route ? (
                            <span className={isWarn ? 'font-bold' : ''}>{row.km.toFixed(1)} km</span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 border-b border-gray-100">
                          {row.route ? formatDuration(row.min) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3.5 border-b border-gray-100">
                          {row.route && row.restaurantCount > 1
                            ? `${row.avgKm.toFixed(1)} km`
                            : <span className="text-gray-300">—</span>
                          }
                        </td>
                        <td className="px-4 py-3.5 border-b border-gray-100">
                          {row.workload ? (
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[13px] font-semibold ${WORKLOAD_STYLE[row.workload]}`}>
                              {WORKLOAD_LABEL[row.workload]}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {/* Average row */}
                  {overviewRows.filter(r => r.route).length >= 2 && (
                    <tr className="bg-gray-50 font-semibold">
                      <td className="px-4 py-3.5">平均值</td>
                      <td className="px-4 py-3.5">{avgRestaurants.toFixed(1)}</td>
                      <td className="px-4 py-3.5">{avgDistance.toFixed(1)} km</td>
                      <td className="px-4 py-3.5">{formatDuration(avgDuration)}</td>
                      <td className="px-4 py-3.5">
                        {avgRestaurants > 1
                          ? `${(avgDistance / (avgRestaurants - 1)).toFixed(1)} km`
                          : '—'
                        }
                      </td>
                      <td className="px-4 py-3.5 text-gray-400">—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ═══ BATCH DETAIL CARDS ═══ */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">批次详情</h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-4">
          {batches.map(batch => {
            const color = getBatchColor(batch.batchIndex)
            const route = routeInfoMap[batch.batchIndex]
            const withCoords = batch.restaurants.filter(r => r.latitude && r.longitude)
            const missingCount = batch.restaurants.length - withCoords.length
            const workload = route ? getWorkload(route.totalDistanceKm, route.totalDurationMin) : null
            const isHeavy = workload === 'heavy'
            const isWarn = route && avgDistance > 0 && route.totalDistanceKm > avgDistance * 2
            const legsExpanded = expandedLegs.has(batch.batchIndex)
            const avgPerStop = route && batch.restaurants.length > 1
              ? route.totalDistanceKm / (batch.restaurants.length - 1)
              : 0

            return (
              <div
                key={batch.batchIndex}
                className={`bg-white rounded-xl border overflow-hidden shadow-sm hover:shadow-md transition-shadow ${
                  isHeavy ? 'border-red-200' : ''
                }`}
              >
                {/* Card top: title + workload badge */}
                <div className="px-5 py-4 flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-1 h-10 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    <div>
                      <h3 className="text-[15px] font-semibold leading-tight">{batch.batchLabel}</h3>
                      <span className="text-[13px] text-gray-400">
                        {batch.restaurants.length} 家餐馆 · {missingCount > 0 ? `${missingCount} 家缺坐标` : '全部有坐标'}
                      </span>
                    </div>
                  </div>
                  {workload && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[13px] font-semibold ${WORKLOAD_STYLE[workload]}`}>
                      {WORKLOAD_LABEL[workload]}
                    </span>
                  )}
                </div>

                {/* Route summary */}
                {route && (
                  <div
                    className={`mx-5 p-4 rounded-xl flex flex-wrap gap-4 items-center ${
                      isHeavy ? 'bg-red-50' : 'bg-blue-50'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className={`text-xl font-bold leading-tight ${isHeavy ? 'text-red-600' : 'text-blue-800'}`}>
                        {route.totalDistanceKm.toFixed(1)} km
                      </span>
                      <span className="text-xs text-gray-500">总距离</span>
                    </div>
                    <div className={`w-px h-8 ${isHeavy ? 'bg-red-200' : 'bg-blue-200'}`} />
                    <div className="flex flex-col">
                      <span className={`text-xl font-bold leading-tight ${isHeavy ? 'text-red-600' : 'text-blue-800'}`}>
                        {formatDuration(route.totalDurationMin)}
                      </span>
                      <span className="text-xs text-gray-500">预计时间</span>
                    </div>
                    <div className={`w-px h-8 ${isHeavy ? 'bg-red-200' : 'bg-blue-200'}`} />
                    <div className="flex flex-col">
                      <span className={`text-xl font-bold leading-tight ${isHeavy ? 'text-red-600' : 'text-blue-800'}`}>
                        {avgPerStop.toFixed(1)} km
                      </span>
                      <span className="text-xs text-gray-500">平均/站</span>
                    </div>
                  </div>
                )}

                {/* Heavy warning message */}
                {isWarn && (
                  <div className="mx-5 mt-2.5 px-3 py-2 bg-red-50 rounded-lg text-[13px] text-red-600 flex items-center gap-1.5">
                    <svg width="16" height="16" fill="#dc2626" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" clipRule="evenodd" />
                    </svg>
                    总距离超过平均值 2 倍，建议检查地理分布是否合理
                  </div>
                )}

                {/* Expandable route legs */}
                {route && route.legs.length > 0 && (
                  <div className="mx-5 mt-3 border-t border-gray-100">
                    <button
                      onClick={() => setExpandedLegs(prev => {
                        const next = new Set(prev)
                        if (next.has(batch.batchIndex)) next.delete(batch.batchIndex)
                        else next.add(batch.batchIndex)
                        return next
                      })}
                      className="flex items-center gap-1 py-2.5 text-[13px] text-blue-600 hover:text-blue-800 transition"
                    >
                      <svg
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                        className={`transition-transform ${legsExpanded ? 'rotate-90' : ''}`}
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      {legsExpanded ? '收起路线详情' : '展开路线详情'}
                    </button>
                    {legsExpanded && (
                      <div className="pb-3 space-y-1">
                        {route.legs.map((leg, i) => (
                          <div key={i} className="flex items-center gap-2 text-[13px]">
                            <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center justify-center shrink-0">
                              {i + 1}
                            </span>
                            <span>{leg.from}</span>
                            <span className="text-gray-400">&rarr;</span>
                            <span>{leg.to}</span>
                            <span className="ml-auto text-gray-500 text-xs whitespace-nowrap">
                              {leg.distance} · {leg.duration}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Restaurant list */}
                <div className="px-5 py-3 space-y-1">
                  {batch.restaurants.map((r, i) => (
                    <div key={r.id} className="flex items-center gap-2 text-[13px]">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: (r.latitude && r.longitude) ? color : '#d1d5db' }}
                      />
                      <span>{i + 1}. {r.name}</span>
                      {r.address && (
                        <span className="ml-auto text-gray-400 text-xs max-w-[220px] truncate">
                          {r.address}
                        </span>
                      )}
                      {(!r.latitude || !r.longitude) && (
                        <span className="text-amber-500 text-xs ml-1">(无坐标)</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
