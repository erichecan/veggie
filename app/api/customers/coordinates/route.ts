import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

// GET /api/customers/coordinates?ids=a,b,c — 只读坐标/地址查询，供司机端路线图使用
// 与 Trip 的 GET/PUT 循环完全解耦：不往 Trip.restaurants 里塞衍生字段，
// 避免前端整份 Trip 对象原样 PUT 回去时，Prisma 因未知字段报错。
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const ids = (searchParams.get('ids') ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    if (ids.length === 0) return NextResponse.json([])

    const customers = await prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, latitude: true, longitude: true, address: true, street: true, street2: true, city: true, zip: true },
    })

    const result = customers.map(c => {
      const parts = [c.street, c.street2, c.city, c.zip].filter(Boolean)
      return {
        id: c.id,
        latitude: c.latitude,
        longitude: c.longitude,
        address: parts.length > 0 ? parts.join(', ') : c.address,
      }
    })

    return NextResponse.json(result)
  })
}
