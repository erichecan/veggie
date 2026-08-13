/**
 * 地理计算 —— 不依赖任何外部服务的那部分（台账 C7）
 * ============================================================================
 * 为什么需要它：路线的里程/时长原本只有一条路 —— Google Distance Matrix。
 * 而 `GOOGLE_MAPS_API_KEY` 是客户要出钱开通的东西，实测**当前根本没有配**
 * （生产与测试库都没有），于是「预计里程/时长」这一栏永远是空的。
 *
 * 直线距离算不出真实路况，但它能回答调度台最常问的那个问题：
 * 「这个批次是不是明显比别的重」。所以没有 key 的时候给一个**标注清楚的估算**，
 * 比给一片空白有用得多 —— 前提是绝不把估算冒充成实际道路里程。
 *
 * ⛔ 纯函数，不引入任何依赖 —— 迁到客户自有服务器后照样能跑（部署铁律）。
 */

export interface LatLng {
  lat: number
  lng: number
}

const EARTH_RADIUS_KM = 6371

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** 两点间大圆距离（公里）。同一点返回 0，不做任何近似截断。 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * 直线距离 → 实际道路距离的放大系数（circuity factor）。
 *
 * 城市路网里实际路径总比直线长。1.3 是都市配送常用的经验值 ——
 * 都柏林市区路网密、单行道多，取这个数比不放大更接近真实。
 * ⚠️ 这是**估算的估算**，所以调用方必须把 `estimated: true` 一起展示出去。
 */
const CIRCUITY_FACTOR = 1.3

/** 市区配送平均车速（km/h），含红绿灯与拥堵，不是限速 */
const URBAN_SPEED_KMH = 28

/** 每个站点的平均停留时间（分钟）：找车位、搬货、签收 */
const STOP_MINUTES = 8

export interface RouteEstimate {
  /** 累计里程（公里，已乘绕行系数） */
  totalDistanceKm: number
  /** 累计时长（分钟，行驶 + 各站停留） */
  totalDurationMin: number
  /** 参与计算的站点数 */
  stopCount: number
  /** 恒为 true —— 提醒调用方这不是实际道路里程 */
  estimated: true
}

/**
 * 按给定顺序把一串坐标串成一条路线，估算里程与时长。
 *
 * 顺序即送货顺序，不做任何重排 —— 路线优化是另一件事，
 * 这里只回答「按调度台排的这个顺序跑，大概多远多久」。
 * 少于 2 个点返回 null（一个点没有"路线"可言）。
 */
export function estimateRoute(points: readonly LatLng[]): RouteEstimate | null {
  if (points.length < 2) return null

  let straightKm = 0
  for (let i = 1; i < points.length; i++) {
    straightKm += haversineKm(points[i - 1]!, points[i]!)
  }

  const roadKm = straightKm * CIRCUITY_FACTOR
  const driveMin = (roadKm / URBAN_SPEED_KMH) * 60
  const stopMin = points.length * STOP_MINUTES

  return {
    totalDistanceKm: Math.round(roadKm * 10) / 10,
    totalDurationMin: Math.ceil(driveMin + stopMin),
    stopCount: points.length,
    estimated: true,
  }
}

/** 把里程/时长写成一行给人看。estimated 时前面加「约」，不让人误当成实测值。 */
export function formatRouteSummary(
  km: number,
  min: number,
  estimated = false,
): string {
  const time = min >= 60 ? `${(min / 60).toFixed(1)} h` : `${min} min`
  return `${estimated ? '约 ' : ''}${km.toFixed(1)} km / ${time}`
}
