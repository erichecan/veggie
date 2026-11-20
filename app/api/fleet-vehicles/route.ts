import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

const normalizePlate = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
const validPlate = (plate: string) => plate.length > 0 && plate.length <= 24 && /^[A-Z0-9 -]+$/.test(plate)

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const includeInactive = new URL(req.url).searchParams.get('includeInactive') === 'true'
    const vehicles = await prisma.fleetVehicle.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { plate: 'asc' },
    })
    return NextResponse.json(vehicles)
  }, { require: 'dispatch.driver_slot.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const body = await req.json()
      const plate = normalizePlate(body.plate)
      if (!validPlate(plate)) return NextResponse.json({ error: '请输入有效车牌（最多 24 位）' }, { status: 400 })
      const existing = await prisma.fleetVehicle.findUnique({ where: { plate } })
      if (existing) {
        if (existing.isActive) return NextResponse.json({ error: '该车牌已存在' }, { status: 409 })
        return NextResponse.json(await prisma.fleetVehicle.update({ where: { id: existing.id }, data: { isActive: true, note: String(body.note ?? '').trim() || null } }))
      }
      return NextResponse.json(await prisma.fleetVehicle.create({ data: { plate, note: String(body.note ?? '').trim() || null } }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/fleet-vehicles]', error)
      return NextResponse.json({ error: '新增车辆失败' }, { status: 500 })
    }
  }, { require: 'dispatch.driver_slot.manage' })
}
