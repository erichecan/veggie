import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const showArchived = searchParams.get('archived') === 'true'
    const slots = await prisma.driverSlot.findMany({
      where: { archived: showArchived },
      orderBy: [{ timeOfDay: 'asc' }, { batchNum: 'asc' }],
    })
    return NextResponse.json(slots)
  } catch (e) {
    console.error('[driver-slots GET]', e)
    return NextResponse.json({ error: 'Failed to fetch driver slots' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { timeOfDay, batchNum, driverName, userId } = body
    if (!timeOfDay || !batchNum || !driverName?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const name = driverName.trim()
    const num = Number(batchNum)
    const boundUserId = userId ? String(userId) : null
    // 唯一约束含归档：撞到归档记录则自动恢复（复活），撞到活跃记录才报冲突
    const existing = await prisma.driverSlot.findUnique({
      where: { timeOfDay_batchNum_driverName: { timeOfDay, batchNum: num, driverName: name } },
    })
    if (existing) {
      if (existing.archived) {
        const restored = await prisma.driverSlot.update({
          where: { id: existing.id },
          data: { archived: false, userId: boundUserId },
        })
        return NextResponse.json(restored, { status: 200 })
      }
      return NextResponse.json({ error: '该司机已在相同时段和批次中' }, { status: 409 })
    }
    const slot = await prisma.driverSlot.create({
      data: { timeOfDay, batchNum: num, driverName: name, userId: boundUserId },
    })
    return NextResponse.json(slot, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: '该司机已在相同时段和批次中（若在归档里请先恢复）' }, { status: 409 })
    }
    console.error('[driver-slots POST]', e)
    return NextResponse.json({ error: 'Failed to create driver slot' }, { status: 500 })
  }
}
