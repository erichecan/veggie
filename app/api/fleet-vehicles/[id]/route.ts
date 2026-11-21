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
      let defaultDriverId: string | null | undefined
      if (Object.prototype.hasOwnProperty.call(body, 'defaultDriverId')) {
        defaultDriverId = body.defaultDriverId ? String(body.defaultDriverId).trim() : null
        if (defaultDriverId) {
          const driver = await prisma.user.findUnique({
            where: { id: defaultDriverId },
            select: { id: true, role: true, roles: true, isActive: true },
          })
          const roles = Array.isArray(driver?.roles) && driver.roles.length > 0 ? driver.roles : [driver?.role]
          if (!driver || !driver.isActive || !roles.includes('DRIVER')) {
            return NextResponse.json({ error: '请选择启用状态的司机账号' }, { status: 400 })
          }
        }
      }
      const vehicle = await prisma.$transaction(async tx => {
        if (defaultDriverId) {
          // 同一司机只允许有一辆默认车。换车时直接解除旧车关联，避免用户先手动清空旧行。
          await tx.fleetVehicle.updateMany({
            where: { defaultDriverId, id: { not: id } },
            data: { defaultDriverId: null },
          })
        }
        return tx.fleetVehicle.update({
          where: { id },
          data: {
            plate,
            note: String(body.note ?? '').trim() || null,
            ...(body.isActive === true ? { isActive: true } : {}),
            ...(defaultDriverId !== undefined ? { defaultDriverId } : {}),
          },
          include: { defaultDriver: { select: { id: true, name: true, isActive: true } } },
        })
      })
      return NextResponse.json(vehicle)
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
