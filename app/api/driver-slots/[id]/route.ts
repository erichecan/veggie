import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deletePalletForDriverSlot } from '@/lib/wave-assign'
import { WavePickLockedError } from '@/lib/wave-pick-lock'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const { timeOfDay, batchNum, driverName, archived, userId } = body

    // 仅绑定/解绑系统用户(司机配置页下拉)
    if (timeOfDay === undefined && batchNum === undefined && driverName === undefined && userId !== undefined) {
      const slot = await prisma.driverSlot.update({
        where: { id },
        data: { userId: userId ? String(userId) : null },
      })
      return NextResponse.json(slot)
    }

    if (archived !== undefined) {
      const before = await prisma.driverSlot.findUnique({ where: { id } })
      const slot = await prisma.driverSlot.update({
        where: { id },
        data: { archived: Boolean(archived) },
      })
      // 归档(=停用这个批次/托盘)时联动清理：未出发波次里挂在这个托盘下的订单整单退回待分配，
      // 保证销售单下拉框可选项和调度台托盘 lane 同步消失。重新启用(archived:false)不触发。
      let unassignedOrderCount = 0
      if (before && !before.archived && slot.archived) {
        const result = await deletePalletForDriverSlot(slot)
        unassignedOrderCount = result.unassignedOrderCount
      }
      return NextResponse.json({ ...slot, unassignedOrderCount })
    }

    if (!timeOfDay || !batchNum || !driverName?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const slot = await prisma.driverSlot.update({
      where: { id },
      data: {
        timeOfDay, batchNum: Number(batchNum), driverName: driverName.trim(),
        ...(userId !== undefined ? { userId: userId ? String(userId) : null } : {}),
      },
    })
    return NextResponse.json(slot)
  } catch (e: unknown) {
    if (e instanceof WavePickLockedError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: '该司机名字已存在' }, { status: 409 })
    }
    console.error('[driver-slots PUT]', e)
    return NextResponse.json({ error: 'Failed to update driver slot' }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const slot = await prisma.driverSlot.update({ where: { id }, data: { archived: true } })
    const { unassignedOrderCount } = await deletePalletForDriverSlot(slot)
    return NextResponse.json({ ok: true, unassignedOrderCount })
  } catch (e) {
    if (e instanceof WavePickLockedError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    console.error('[driver-slots DELETE]', e)
    return NextResponse.json({ error: 'Failed to archive driver slot' }, { status: 500 })
  }
}
