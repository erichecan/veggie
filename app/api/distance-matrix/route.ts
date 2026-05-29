import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { getRouteDistance } from '@/lib/google-maps'

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
      const route = await getRouteDistance(waypoints)

      if (!route) {
        return NextResponse.json({ error: 'Distance Matrix API 调用失败' }, { status: 502 })
      }

      const totalKm = (route.totalDistanceMeters / 1000).toFixed(1)
      const totalMin = Math.ceil(route.totalDurationSeconds / 60)
      const totalHours = (totalMin / 60).toFixed(1)

      return NextResponse.json({
        totalDistanceKm: parseFloat(totalKm),
        totalDurationMin: totalMin,
        summary: `${totalKm} km / ${totalMin >= 60 ? totalHours + ' h' : totalMin + ' min'}`,
        stops: withCoords.map(c => ({ id: c.id, name: c.name })),
        missingCoords: missingCoords.map(c => ({ id: c.id, name: c.name })),
        legs: route.legs.map((leg, i) => ({
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
