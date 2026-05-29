import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const { timeOfDay, batchNum, driverName, archived } = body

    if (archived !== undefined) {
      const slot = await prisma.driverSlot.update({
        where: { id },
        data: { archived: Boolean(archived) },
      })
      return NextResponse.json(slot)
    }

    if (!timeOfDay || !batchNum || !driverName?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const slot = await prisma.driverSlot.update({
      where: { id },
      data: { timeOfDay, batchNum: Number(batchNum), driverName: driverName.trim() },
    })
    return NextResponse.json(slot)
  } catch (e: unknown) {
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
    await prisma.driverSlot.update({ where: { id }, data: { archived: true } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[driver-slots DELETE]', e)
    return NextResponse.json({ error: 'Failed to archive driver slot' }, { status: 500 })
  }
}
