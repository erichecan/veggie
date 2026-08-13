import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { geocodeAddress, hasMapsApiKey } from '@/lib/google-maps'

// POST /api/geocode — 批量 geocode 客户地址，存入 DB
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      // ⛔ 没配 key 时必须**明说**，不能假装跑了一遍然后 0 条成功。
      // 原实现：geocodeAddress 无 key 直接返回 null → 每条记 failed → 接口 200，
      // 前端 catch 里又写着 `// silent` → **用户点「自动解析地址」完全没反应**。
      // 浏览器实点才发现的死按钮（C7）。
      if (!hasMapsApiKey()) {
        return NextResponse.json({
          error: '未配置地图服务（GOOGLE_MAPS_API_KEY），无法自动解析地址',
          hint: '可以先在客户资料里手工填写经纬度，或让管理员配置地图服务密钥',
          code: 'MAPS_NOT_CONFIGURED',
        }, { status: 503 })
      }

      const { customerIds } = (await req.json()) as { customerIds?: string[] }

      const where: Record<string, unknown> = {}
      if (customerIds?.length) {
        where.id = { in: customerIds }
      } else {
        where.latitude = null
      }

      const customers = await prisma.customer.findMany({
        where,
        select: { id: true, name: true, address: true, street: true, street2: true, city: true, zip: true, country: true, latitude: true, longitude: true },
        take: 50,
      })

      const results: { id: string; name: string; success: boolean; latitude?: number; longitude?: number }[] = []

      for (const c of customers) {
        const parts = [c.street, c.street2, c.city, c.zip, c.country].filter(Boolean)
        const fullAddress = parts.length > 0 ? parts.join(', ') : c.address

        if (!fullAddress.trim()) {
          results.push({ id: c.id, name: c.name, success: false })
          continue
        }

        const geo = await geocodeAddress(fullAddress)
        if (geo) {
          await prisma.customer.update({
            where: { id: c.id },
            data: { latitude: geo.latitude, longitude: geo.longitude },
          })
          results.push({ id: c.id, name: c.name, success: true, latitude: geo.latitude, longitude: geo.longitude })
        } else {
          results.push({ id: c.id, name: c.name, success: false })
        }
      }

      return NextResponse.json({
        geocoded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results,
      })
    } catch (error) {
      console.error('[POST /api/geocode]', error)
      return NextResponse.json({ error: 'Geocoding 失败' }, { status: 500 })
    }
  })
}
