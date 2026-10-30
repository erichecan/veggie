import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { dispatchWave } from '@/lib/wave-dispatch'
import { completeWaveDelivery, describeFailures } from '@/lib/wave-complete'
import { businessTodayDateOnly } from '@/lib/wave-dispatch'

/** At 22:00, finish today's ready deliveries; depart any batch the operator missed. */
const SCAN_LOOKBACK_DAYS = 30
const HISTORICAL_FLOOR_DATE = new Date('2026-09-13T00:00:00Z')

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = businessTodayDateOnly()
    const todayStart = new Date(`${today}T00:00:00Z`)
    const lookbackStart = new Date(todayStart)
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - SCAN_LOOKBACK_DAYS)
    const scanFloor = lookbackStart > HISTORICAL_FLOOR_DATE ? lookbackStart : HISTORICAL_FLOOR_DATE

    const candidates = await prisma.pickingWave.findMany({
      where: {
        completedAt: null,
        waveDate: { gt: scanFloor, lte: todayStart },
        orderIds: { isEmpty: false },
        OR: [
          { dispatchedAt: { not: null } },
          { assignmentDoneAt: { not: null } },
          { pickLockedAt: { not: null } },
        ],
      },
      select: { id: true, name: true, orderIds: true, dispatchedAt: true, waveDate: true },
      orderBy: { waveDate: 'asc' },
    })

    const results: Array<{ waveId: string; waveName: string | null; status: 'completed' | 'skipped' | 'failed'; detail: string }> = []
    let autoDeparted = 0

    for (const wave of candidates) {
      try {
        if (!wave.dispatchedAt) {
          const departure = await dispatchWave(wave.id, wave.waveDate?.toISOString().slice(0, 10))
          if (!departure.ok) {
            results.push({ waveId: wave.id, waveName: wave.name, status: 'skipped', detail: departure.reason })
            continue
          }
          autoDeparted++
        }

        const completed = await completeWaveDelivery(wave.id, { name: 'System 22:00 Auto Completion' })
        if (!completed.ok) {
          results.push({ waveId: wave.id, waveName: wave.name, status: 'skipped', detail: completed.reason })
          continue
        }

        const detail = `22:00 自动完成配送：${completed.completedIds.length}/${wave.orderIds.length} 张订单完成，行程 ${completed.tripIds.length} 条完成${describeFailures(completed.failures)}`
        await writeLog({
          userId: 'system-cron', userEmail: 'system', userName: 'System 22:00 Auto Completion',
          action: 'UPDATE', resource: 'picking-wave', resourceId: wave.id, detail,
        })
        results.push({ waveId: wave.id, waveName: wave.name, status: 'completed', detail })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({ waveId: wave.id, waveName: wave.name, status: 'failed', detail: message })
        console.error('[POST /api/cron/auto-complete-delivery]', wave.id, error)
      }
    }

    return NextResponse.json({
      scannedBusinessDate: today,
      scanFloorDate: scanFloor.toISOString().slice(0, 10),
      total: candidates.length,
      autoDeparted,
      completed: results.filter(r => r.status === 'completed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    })
  } catch (error) {
    console.error('[POST /api/cron/auto-complete-delivery]', error)
    const message = error instanceof Error ? error.message : '自动完成配送失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
