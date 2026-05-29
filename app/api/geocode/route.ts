import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { geocodeAddress } from '@/lib/google-maps'

// POST /api/geocode — 批量 geocode 客户地址，存入 DB
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
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
