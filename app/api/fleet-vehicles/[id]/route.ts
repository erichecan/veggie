import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

const normalizePlate = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
const validPlate = (plate: string) => plate.length > 0 && plate.length <= 24 && /^[A-Z0-9 -]+$/.test(plate)

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await ctx.params
      const body = await req.json()
      const plate = normalizePlate(body.plate)
      if (!validPlate(plate)) return NextResponse.json({ error: '请输入有效车牌（最多 24 位）' }, { status: 400 })
      const existing = await prisma.fleetVehicle.findUnique({ where: { plate } })
      if (existing && existing.id !== id) return NextResponse.json({ error: '该车牌已存在' }, { status: 409 })
      return NextResponse.json(await prisma.fleetVehicle.update({
        where: { id },
        data: { plate, note: String(body.note ?? '').trim() || null, ...(body.isActive === true ? { isActive: true } : {}) },
      }))
    } catch (error) {
      console.error('[PUT /api/fleet-vehicles/:id]', error)
      return NextResponse.json({ error: '更新车辆失败' }, { status: 500 })
    }
  }, { require: 'dispatch.driver_slot.manage' })
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await ctx.params
      return NextResponse.json(await prisma.fleetVehicle.update({ where: { id }, data: { isActive: false } }))
    } catch (error) {
      console.error('[DELETE /api/fleet-vehicles/:id]', error)
      return NextResponse.json({ error: '停用车辆失败' }, { status: 500 })
    }
  }, { require: 'dispatch.driver_slot.manage' })
}
