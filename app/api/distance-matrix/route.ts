import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { getRouteDistance, hasMapsApiKey } from '@/lib/google-maps'
import { estimateRoute, formatRouteSummary } from '@/lib/geo'

// POST /api/distance-matrix — 计算一个批次的路线距离和时间
// Body: { customerIds: string[] } — 按送货顺序排列
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const { customerIds } = (await req.json()) as { customerIds: string[] }

      if (!customerIds?.length) {
        return NextResponse.json({ error: '请提供客户 ID 列表' }, { status: 400 })
      }

      const customers = await prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, name: true, latitude: true, longitude: true },
      })

      const ordered = customerIds
        .map(id => customers.find(c => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)

      const withCoords = ordered.filter(c => c.latitude !== null && c.longitude !== null)
      const missingCoords = ordered.filter(c => c.latitude === null || c.longitude === null)

      if (withCoords.length < 2) {
        return NextResponse.json({
          error: '至少需要 2 个有坐标的客户',
          missingCoords: missingCoords.map(c => ({ id: c.id, name: c.name })),
        }, { status: 400 })
      }

      const waypoints = withCoords.map(c => ({ lat: c.latitude!, lng: c.longitude! }))

      // ── 没有 Google key 时降级为直线估算 ──────────────────────────────────
      // 实测：生产与测试库都没有配 GOOGLE_MAPS_API_KEY，于是「预计里程/时长」
      // 这一栏永远是空的。直线估算答不了真实路况，但能回答调度台最常问的
      // 「这个批次是不是明显比别的重」。
      // ⛔ 必须把 estimated 标出去，绝不把估算冒充成实际道路里程。
      if (!hasMapsApiKey()) {
        const est = estimateRoute(waypoints)
        if (!est) {
          return NextResponse.json({ error: '至少需要 2 个有坐标的客户' }, { status: 400 })
        }
        return NextResponse.json({
          totalDistanceKm: est.totalDistanceKm,
          totalDurationMin: est.totalDurationMin,
          summary: formatRouteSummary(est.totalDistanceKm, est.totalDurationMin, true),
          estimated: true,
          estimateNote: '未配置地图服务，按直线距离估算（含 1.3 绕行系数、市区均速 28km/h、每站停留 8 分钟）',
          stops: withCoords.map(c => ({ id: c.id, name: c.name })),
          missingCoords: missingCoords.map(c => ({ id: c.id, name: c.name })),
          legs: [],
        })
      }

      const route = await getRouteDistance(waypoints)

      if (!route) {
        return NextResponse.json({ error: '地图服务调用失败，请稍后重试' }, { status: 502 })
      }

      const totalKm = (route.totalDistanceMeters / 1000).toFixed(1)
      const totalMin = Math.ceil(route.totalDurationSeconds / 60)

      return NextResponse.json({
        totalDistanceKm: parseFloat(totalKm),
        totalDurationMin: totalMin,
        summary: formatRouteSummary(parseFloat(totalKm), totalMin, false),
        estimated: false,
        stops: withCoords.map(c => ({ id: c.id, name: c.name })),
        missingCoords: missingCoords.map(c => ({ id: c.id, name: c.name })),
        legs: route.legs.map((leg) => ({
          from: withCoords[leg.originIndex]?.name,
          to: withCoords[leg.destIndex]?.name,
          distance: leg.distanceText,
          duration: leg.durationText,
        })),
      })
    } catch (error) {
      console.error('[POST /api/distance-matrix]', error)
      return NextResponse.json({ error: '距离计算失败' }, { status: 500 })
    }
  })
}
