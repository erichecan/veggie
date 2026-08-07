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

      // 一个司机+时段只建一条波次(不管配了几个托盘/batchNum)，见 lib/wave-assign.ts。
      // driverSlotId 只留兼容快照，取该组里第一个(batchNum 最小的)slot 代表。
      const groups = new Map<string, typeof slots[number][]>()
      for (const slot of slots) {
        const key = `${slot.driverName}::${slot.timeOfDay}`
        const list = groups.get(key) ?? []
        list.push(slot)
        groups.set(key, list)
      }

      const existing = await prisma.pickingWave.findMany({
        where: { waveDate },
        select: { driverName: true, timeOfDay: true, waveNumber: true },
      })
      const existingKeys = new Set(existing.map(w => `${w.driverName}::${w.timeOfDay}`))
      let nextNumber = existing.length > 0
        ? Math.max(...existing.map(w => w.waveNumber ?? 0)) + 1
        : 1

      const created = []
      for (const [key, groupSlots] of groups) {
        if (existingKeys.has(key)) continue // already has a wave
        const repSlot = groupSlots[0]
        const waveType = repSlot.timeOfDay === 'pm' ? 'bulk' : 'loose'
        const dateLabel = waveDate.toISOString().slice(0, 10)
        const wave = await prisma.pickingWave.create({
          data: {
            name: `${dateLabel} #${nextNumber} ${repSlot.driverName}`,
            waveDate,
            waveNumber: nextNumber,
            waveType,
            driverSlotId: repSlot.id,
            driverName: repSlot.driverName,
            timeOfDay: repSlot.timeOfDay,
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
        include: { pallets: { orderBy: { seq: 'asc' } } },
      })

      return NextResponse.json(serializeApi(all))
    } catch (error) {
      console.error('[POST /api/waves/generate-daily]', error)
      return NextResponse.json({ error: '生成每日波次失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.create' })
}

function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}
