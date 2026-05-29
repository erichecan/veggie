'use client'
import { useEffect, useRef, useCallback, useState } from 'react'
import 'leaflet/dist/leaflet.css'

export interface MapMarker {
  lat: number
  lng: number
  label: string
  color: string
  popup?: string
  batchIndex?: number
  markerNumber?: number
}

export interface ConvexHullGroup {
  batchIndex: number
  points: { lat: number; lng: number }[]
  color: string
}

interface BatchMapProps {
  markers: MapMarker[]
  height?: string
  className?: string
  convexHulls?: ConvexHullGroup[]
  hiddenBatches?: Set<number>
}

const BATCH_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4',
]

export function getBatchColor(index: number): string {
  return BATCH_COLORS[index % BATCH_COLORS.length]
}

// --- Convex Hull (Andrew's Monotone Chain) ---
export function computeConvexHull(
  points: { lat: number; lng: number }[],
): { lat: number; lng: number }[] {
  if (points.length <= 2) return [...points]
  const sorted = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat)

  const cross = (
    o: { lat: number; lng: number },
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
  ) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)

  const lower: { lat: number; lng: number }[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }

  const upper: { lat: number; lng: number }[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }

  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// --- Google Maps loader ---
const GOOGLE_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ''

let googleMapsState: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle'
let googleMapsPromise: Promise<boolean> | null = null

function loadGoogleMaps(): Promise<boolean> {
  if (googleMapsState === 'loaded' && window.google?.maps) return Promise.resolve(true)
  if (googleMapsState === 'failed') return Promise.resolve(false)
  if (googleMapsPromise) return googleMapsPromise

  if (!GOOGLE_API_KEY) {
    googleMapsState = 'failed'
    return Promise.resolve(false)
  }

  googleMapsState = 'loading'
  googleMapsPromise = new Promise((resolve) => {
    if (window.google?.maps) {
      googleMapsState = 'loaded'
      resolve(true)
      return
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&v=weekly`
    script.async = true
    script.defer = true
    script.onload = () => {
      googleMapsState = 'loaded'
      resolve(true)
    }
    script.onerror = () => {
      googleMapsState = 'failed'
      resolve(false)
    }
    document.head.appendChild(script)

    setTimeout(() => {
      if (googleMapsState === 'loading') {
        googleMapsState = 'failed'
        resolve(false)
      }
    }, 8000)
  })
  return googleMapsPromise
}

// --- Leaflet loader ---
let leafletPromise: Promise<typeof import('leaflet')> | null = null

function loadLeaflet(): Promise<typeof import('leaflet')> {
  if (leafletPromise) return leafletPromise
  leafletPromise = (async () => {
    const L = await import('leaflet')
    return L.default || L
  })()
  return leafletPromise
}

function filterOutliers(markers: MapMarker[]): MapMarker[] {
  if (markers.length < 3) return markers
  const lats = markers.map(m => m.lat).sort((a, b) => a - b)
  const lngs = markers.map(m => m.lng).sort((a, b) => a - b)
  const medianLat = lats[Math.floor(lats.length / 2)]
  const medianLng = lngs[Math.floor(lngs.length / 2)]
  const threshold = 3
  return markers.filter(m =>
    Math.abs(m.lat - medianLat) <= threshold && Math.abs(m.lng - medianLng) <= threshold
  )
}

const EMPTY_HULLS: ConvexHullGroup[] = []
const EMPTY_HIDDEN = new Set<number>()

export default function BatchMap({
  markers,
  height = '350px',
  className = '',
  convexHulls = EMPTY_HULLS,
  hiddenBatches = EMPTY_HIDDEN,
}: BatchMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<'loading' | 'google' | 'leaflet'>('loading')

  // Google Maps refs — per-batch for visibility toggle
  const gMapInstance = useRef<google.maps.Map | null>(null)
  const gMarkersByBatch = useRef<Map<number, google.maps.marker.AdvancedMarkerElement[]>>(new Map())
  const gHullsByBatch = useRef<Map<number, google.maps.Polygon>>(new Map())
  const gUnbatchedMarkers = useRef<google.maps.marker.AdvancedMarkerElement[]>([])

  // Leaflet refs — per-batch for visibility toggle
  const lMapInstance = useRef<L.Map | null>(null)
  const lMarkersByBatch = useRef<Map<number, L.CircleMarker[]>>(new Map())
  const lHullsByBatch = useRef<Map<number, L.Polygon>>(new Map())
  const lUnbatchedMarkers = useRef<L.CircleMarker[]>([])

  // Stable ref so async init can read latest hidden state without being a dep
  const hiddenRef = useRef(hiddenBatches)
  useEffect(() => { hiddenRef.current = hiddenBatches }, [hiddenBatches])

  // ── Google visibility helper ─────────────────────────────────────
  function applyGoogleHidden(hidden: Set<number>) {
    gMarkersByBatch.current.forEach((arr, idx) => {
      const hide = hidden.has(idx)
      arr.forEach(m => { m.map = hide ? null : gMapInstance.current })
    })
    gHullsByBatch.current.forEach((poly, idx) => {
      poly.setMap(hidden.has(idx) ? null : gMapInstance.current)
    })
  }

  // ── Leaflet visibility helper ────────────────────────────────────
  function applyLeafletHidden(hidden: Set<number>) {
    const map = lMapInstance.current
    if (!map) return
    lMarkersByBatch.current.forEach((arr, idx) => {
      const hide = hidden.has(idx)
      arr.forEach(m => {
        if (hide && map.hasLayer(m)) m.removeFrom(map)
        else if (!hide && !map.hasLayer(m)) m.addTo(map)
      })
    })
    lHullsByBatch.current.forEach((poly, idx) => {
      if (hidden.has(idx) && map.hasLayer(poly)) poly.removeFrom(map)
      else if (!hidden.has(idx) && !map.hasLayer(poly)) poly.addTo(map)
    })
  }

  // ── Init: Google ─────────────────────────────────────────────────
  const initGoogleMap = useCallback(async () => {
    if (!mapRef.current || markers.length === 0) return

    const { Map } = await google.maps.importLibrary('maps') as google.maps.MapsLibrary
    await google.maps.importLibrary('marker')

    // Cleanup previous
    gMarkersByBatch.current.forEach(arr => arr.forEach(m => { m.map = null }))
    gMarkersByBatch.current.clear()
    gUnbatchedMarkers.current.forEach(m => { m.map = null })
    gUnbatchedMarkers.current = []
    gHullsByBatch.current.forEach(p => p.setMap(null))
    gHullsByBatch.current.clear()

    if (!gMapInstance.current) {
      gMapInstance.current = new Map(mapRef.current!, {
        mapId: 'batch-analysis-map',
        zoom: 8,
        center: { lat: markers[0].lat, lng: markers[0].lng },
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      })
    }

    // Create markers
    markers.forEach((m, i) => {
      const pinEl = document.createElement('div')
      pinEl.style.cssText = `
        background: ${m.color};
        color: white;
        border: 2px solid white;
        border-radius: 50%;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: bold;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      `
      pinEl.textContent = String(m.markerNumber ?? (i + 1))

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: gMapInstance.current!,
        position: { lat: m.lat, lng: m.lng },
        content: pinEl,
        title: m.label,
      })

      const infoWindow = new google.maps.InfoWindow({
        content: `<b>${m.label}</b>${m.popup ? `<br/>${m.popup}` : ''}`,
      })
      marker.addListener('click', () => {
        infoWindow.open({ anchor: marker, map: gMapInstance.current! })
      })

      if (m.batchIndex !== undefined) {
        if (!gMarkersByBatch.current.has(m.batchIndex)) {
          gMarkersByBatch.current.set(m.batchIndex, [])
        }
        gMarkersByBatch.current.get(m.batchIndex)!.push(marker)
      } else {
        gUnbatchedMarkers.current.push(marker)
      }
    })

    // Create convex hull polygons
    convexHulls.forEach(hull => {
      if (hull.points.length < 3) return
      const polygon = new google.maps.Polygon({
        paths: hull.points.map(p => ({ lat: p.lat, lng: p.lng })),
        fillColor: hull.color,
        fillOpacity: 0.12,
        strokeColor: hull.color,
        strokeOpacity: 0.4,
        strokeWeight: 2,
        map: gMapInstance.current!,
      })
      gHullsByBatch.current.set(hull.batchIndex, polygon)
    })

    // Fit bounds
    const inliers = filterOutliers(markers)
    const bounds = new google.maps.LatLngBounds()
    inliers.forEach(m => bounds.extend({ lat: m.lat, lng: m.lng }))

    gMapInstance.current.fitBounds(bounds, { top: 30, bottom: 30, left: 30, right: 30 })

    const listener = google.maps.event.addListener(gMapInstance.current, 'idle', () => {
      const zoom = gMapInstance.current!.getZoom()
      if (zoom && zoom > 14) gMapInstance.current!.setZoom(14)
      google.maps.event.removeListener(listener)
    })

    // Apply initial hidden state from ref
    applyGoogleHidden(hiddenRef.current)
  }, [markers, convexHulls])

  // ── Init: Leaflet ────────────────────────────────────────────────
  const initLeafletMap = useCallback(async () => {
    if (!mapRef.current || markers.length === 0) return

    const L = await loadLeaflet()

    // Cleanup previous
    lMarkersByBatch.current.forEach(arr => arr.forEach(m => m.remove()))
    lMarkersByBatch.current.clear()
    lUnbatchedMarkers.current.forEach(m => m.remove())
    lUnbatchedMarkers.current = []
    lHullsByBatch.current.forEach(p => p.remove())
    lHullsByBatch.current.clear()

    if (lMapInstance.current) {
      lMapInstance.current.remove()
      lMapInstance.current = null
    }

    const map = L.map(mapRef.current!, { zoomControl: true })
    lMapInstance.current = map

    L.tileLayer('/api/tile?z={z}&x={x}&y={y}', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map)

    // Create markers
    markers.forEach((m, i) => {
      const circle = L.circleMarker([m.lat, m.lng], {
        radius: 14,
        fillColor: m.color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      }).addTo(map)

      circle.bindTooltip(String(m.markerNumber ?? (i + 1)), {
        permanent: true,
        direction: 'center',
        className: 'batch-marker-label',
      })

      const popupContent = `<b>${m.label}</b>${m.popup ? `<br/>${m.popup}` : ''}`
      circle.bindPopup(popupContent)

      if (m.batchIndex !== undefined) {
        if (!lMarkersByBatch.current.has(m.batchIndex)) {
          lMarkersByBatch.current.set(m.batchIndex, [])
        }
        lMarkersByBatch.current.get(m.batchIndex)!.push(circle)
      } else {
        lUnbatchedMarkers.current.push(circle)
      }
    })

    // Create convex hull polygons
    convexHulls.forEach(hull => {
      if (hull.points.length < 3) return
      const polygon = L.polygon(
        hull.points.map(p => [p.lat, p.lng] as [number, number]),
        {
          fillColor: hull.color,
          fillOpacity: 0.12,
          color: hull.color,
          weight: 2,
          opacity: 0.4,
        },
      ).addTo(map)
      lHullsByBatch.current.set(hull.batchIndex, polygon)
    })

    // Fit bounds
    const inliers = filterOutliers(markers)
    const bounds = L.latLngBounds([])
    inliers.forEach(m => bounds.extend([m.lat, m.lng]))

    if (!bounds.isValid()) return

    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 })

    const reFit = () => {
      if (map !== lMapInstance.current) return
      map.invalidateSize()
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 })
    }
    setTimeout(reFit, 100)
    setTimeout(reFit, 400)
    setTimeout(reFit, 800)

    // Apply initial hidden state from ref
    applyLeafletHidden(hiddenRef.current)
  }, [markers, convexHulls])

  // ── Init router ──────────────────────────────────────────────────
  const initMap = useCallback(async () => {
    if (!mapRef.current || markers.length === 0) return
    const googleOk = await loadGoogleMaps()
    if (googleOk) {
      setEngine('google')
      await initGoogleMap()
    } else {
      setEngine('leaflet')
      await initLeafletMap()
    }
  }, [markers, convexHulls, initGoogleMap, initLeafletMap])

  useEffect(() => { initMap() }, [initMap])

  // ── Visibility toggle (runs when hiddenBatches changes) ──────────
  useEffect(() => {
    if (engine === 'loading') return
    if (engine === 'google') applyGoogleHidden(hiddenBatches)
    else applyLeafletHidden(hiddenBatches)
  }, [hiddenBatches, engine])

  // ── Cleanup ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      gMarkersByBatch.current.forEach(arr => arr.forEach(m => { m.map = null }))
      gMarkersByBatch.current.clear()
      gUnbatchedMarkers.current.forEach(m => { m.map = null })
      gUnbatchedMarkers.current = []
      gHullsByBatch.current.forEach(p => p.setMap(null))
      gHullsByBatch.current.clear()
      if (lMapInstance.current) {
        lMapInstance.current.remove()
        lMapInstance.current = null
      }
    }
  }, [])

  return (
    <div className="relative">
      <div ref={mapRef} style={{ height }} className={`rounded-lg border ${className}`} />
      {engine === 'leaflet' && (
        <div className="absolute top-2 right-2 z-[1000] bg-amber-50 border border-amber-200 rounded px-2 py-1 text-xs text-amber-700">
          Google Maps 不可用，使用 OSM 地图
        </div>
      )}
      <style jsx global>{`
        .batch-marker-label {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: white !important;
          font-size: 11px !important;
          font-weight: bold !important;
        }
      `}</style>
    </div>
  )
}
