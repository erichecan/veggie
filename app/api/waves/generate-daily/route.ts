import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function POST(req: Request) {
  return withAuth(req, async (_user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const dateStr = body.date as string | undefined
      const waveDate = dateStr ? new Date(dateStr + 'T00:00:00Z') : todayUTC()

      const slots = await prisma.driverSlot.findMany({
        where: { archived: false },
        orderBy: [{ batchNum: 'asc' }, { driverName: 'asc' }],
      })

      if (slots.length === 0) {
        return NextResponse.json({ error: '没有可用的 DriverSlot，请先配置司机批次' }, { status: 400 })
      }

      // Find which driverSlotIds already have a wave for this date
      const existing = await prisma.pickingWave.findMany({
        where: { waveDate },
        select: { driverSlotId: true, waveNumber: true },
      })
      const existingSlotIds = new Set(existing.map(w => w.driverSlotId))
      // Determine the next waveNumber (continue from the highest existing)
      let nextNumber = existing.length > 0
        ? Math.max(...existing.map(w => w.waveNumber ?? 0)) + 1
        : 1

      const created = []
      for (const slot of slots) {
        if (existingSlotIds.has(slot.id)) continue // already has a wave

        const waveType = slot.timeOfDay === 'pm' ? 'bulk' : 'loose'
        const dateLabel = waveDate.toISOString().slice(0, 10)
        const wave = await prisma.pickingWave.create({
          data: {
            name: `${dateLabel} #${nextNumber} ${slot.driverName}`,
            waveDate,
            waveNumber: nextNumber,
            waveType,
            driverSlotId: slot.id,
            driverName: slot.driverName,
            orderIds: [],
            zones: [],
            status: 'PENDING',
          },
        })
        created.push(wave)
        nextNumber++
      }

      const all = await prisma.pickingWave.findMany({
        where: { waveDate },
        orderBy: { waveNumber: 'asc' },
      })

      return NextResponse.json(serializeApi(all))
    } catch (error) {
      console.error('[POST /api/waves/generate-daily]', error)
      return NextResponse.json({ error: '生成每日波次失败' }, { status: 500 })
    }
  })
}

function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}
