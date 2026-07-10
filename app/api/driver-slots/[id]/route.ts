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
      if (!before) return NextResponse.json({ error: '托盘不存在' }, { status: 404 })

      // 归档(=停用这个批次/托盘)时联动清理：未出发波次里挂在这个托盘下的订单整单退回待分配，
      // 保证销售单下拉框可选项和调度台托盘 lane 同步消失。重新启用(archived:false)不触发。
      // 必须先清理成功、再落 archived:true——反过来的话，清理撞上拣货锁抛错时 archived 已经
      // 生效但订单没退回待分配，会留下"托盘从 UI 消失但订单仍孤儿挂着"的不一致状态。
      let unassignedOrderCount = 0
      if (!before.archived && archived) {
        const result = await deletePalletForDriverSlot(before)
        unassignedOrderCount = result.unassignedOrderCount
      }
      const slot = await prisma.driverSlot.update({
        where: { id },
        data: { archived: Boolean(archived) },
      })
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
    const slot = await prisma.driverSlot.findUnique({ where: { id } })
    if (!slot) return NextResponse.json({ error: '托盘不存在' }, { status: 404 })
    // 同 PUT 归档分支：先清理再归档，避免拣货锁挡住清理时留下"已归档但订单孤儿挂着"的半成状态。
    const { unassignedOrderCount } = await deletePalletForDriverSlot(slot)
    await prisma.driverSlot.update({ where: { id }, data: { archived: true } })
    return NextResponse.json({ ok: true, unassignedOrderCount })
  } catch (e) {
    if (e instanceof WavePickLockedError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    console.error('[driver-slots DELETE]', e)
    return NextResponse.json({ error: 'Failed to archive driver slot' }, { status: 500 })
  }
}
