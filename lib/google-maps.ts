const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? ''

export interface GeocodingResult {
  latitude: number
  longitude: number
  formattedAddress: string
}

export async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  if (!API_KEY || !address.trim()) return null

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`
  const res = await fetch(url)
  const data = await res.json()

  if (data.status !== 'OK' || !data.results?.[0]) return null

  const { lat, lng } = data.results[0].geometry.location
  return {
    latitude: lat,
    longitude: lng,
    formattedAddress: data.results[0].formatted_address,
  }
}

export interface DistanceMatrixEntry {
  originIndex: number
  destIndex: number
  distanceMeters: number
  distanceText: string
  durationSeconds: number
  durationText: string
}

export interface DistanceMatrixResult {
  entries: DistanceMatrixEntry[]
  totalDistanceMeters: number
  totalDurationSeconds: number
}

export async function getDistanceMatrix(
  origins: { lat: number; lng: number }[],
  destinations: { lat: number; lng: number }[],
): Promise<DistanceMatrixResult | null> {
  if (!API_KEY || origins.length === 0 || destinations.length === 0) return null

  const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|')
  const destsStr = destinations.map(d => `${d.lat},${d.lng}`).join('|')

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originsStr}&destinations=${destsStr}&mode=driving&key=${API_KEY}`
  const res = await fetch(url)
  const data = await res.json()

  if (data.status !== 'OK') return null

  const entries: DistanceMatrixEntry[] = []
  let totalDistanceMeters = 0
  let totalDurationSeconds = 0

  for (let i = 0; i < data.rows.length; i++) {
    for (let j = 0; j < data.rows[i].elements.length; j++) {
      const el = data.rows[i].elements[j]
      if (el.status !== 'OK') continue
      entries.push({
        originIndex: i,
        destIndex: j,
        distanceMeters: el.distance.value,
        distanceText: el.distance.text,
        durationSeconds: el.duration.value,
        durationText: el.duration.text,
      })
      if (i === 0 || j === i) {
        totalDistanceMeters += el.distance.value
        totalDurationSeconds += el.duration.value
      }
    }
  }

  return { entries, totalDistanceMeters, totalDurationSeconds }
}

export async function getRouteDistance(
  waypoints: { lat: number; lng: number }[],
): Promise<{ totalDistanceMeters: number; totalDurationSeconds: number; legs: DistanceMatrixEntry[] } | null> {
  if (!API_KEY || waypoints.length < 2) return null

  const legs: DistanceMatrixEntry[] = []
  let totalDistanceMeters = 0
  let totalDurationSeconds = 0

  for (let i = 0; i < waypoints.length - 1; i++) {
    const origin = waypoints[i]
    const dest = waypoints[i + 1]
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}&mode=driving&key=${API_KEY}`
    const res = await fetch(url)
    const data = await res.json()

    if (data.status !== 'OK' || data.rows[0]?.elements[0]?.status !== 'OK') continue

    const el = data.rows[0].elements[0]
    legs.push({
      originIndex: i,
      destIndex: i + 1,
      distanceMeters: el.distance.value,
      distanceText: el.distance.text,
      durationSeconds: el.duration.value,
      durationText: el.duration.text,
    })
    totalDistanceMeters += el.distance.value
    totalDurationSeconds += el.duration.value
  }

  return { totalDistanceMeters, totalDurationSeconds, legs }
}
