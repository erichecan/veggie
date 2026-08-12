import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

/**
 * GET /api/waves/print-status?date=YYYY-MM-DD
 * ============================================================================
 * 台账 D1。回答一个问题：**这一天的每个批次，各类单据打过没有、打了几次、谁打的。**
 *
 * 为什么需要它：打印中心卡片上的「✓ 已打印」绿标此前存在 **localStorage**
 * (`veggie-printed-batches-{date}`)。换台电脑、换浏览器、清缓存，状态就没了；
 * 页面上还有个「清除已打印记录」按钮能随手抹掉。也就是说打印员 A 打过的单，
 * 打印员 B 那边显示成没打过 —— 这不是显示问题，是会导致**漏打或重复打**。
 *
 * 而服务端其实一直有真痕：每次打印都写了 ActionLog（pick-lock 顺带记拣货单，
 * print-log 记送货/销售/汇总单）。生产副本里已积累 358+ 条。本接口只是把这份
 * 已经存在的数据聚合出来，**不新增任何写入路径**。
 *
 * 口径：只认 `changes.print` 这个结构化段（20260811 起写入）。老日志只有中文
 * detail，按它反解类型太脆（改一个字就全断），所以老日志**不计入类型明细**，
 * 只在 legacyCount 里给出总数，让界面能说明「这天另有 N 条更早的打印记录」。
 */

export const dynamic = 'force-dynamic'

interface PrintMark {
  count: number
  lastAt: string
  lastBy: string
}

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const date = (searchParams.get('date') ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: 'date 必填，格式 YYYY-MM-DD' }, { status: 400 })
      }

      // 先拿这天的波次，用来把日志限定在本日范围内。
      // 不能只按 ActionLog.createdAt 过滤：隔天补打、提前一天打，都是真实场景，
      // 打印的是"哪天的货"由波次决定，不是由"什么时候按下打印键"决定。
      const waves = await prisma.pickingWave.findMany({
        where: { waveDate: new Date(`${date}T00:00:00.000Z`) },
        select: { id: true },
      })
      const waveIds = waves.map((w) => w.id)
      if (waveIds.length === 0) {
        return NextResponse.json({ date, waves: {}, legacyCount: 0, printedWaveCount: 0, totalWaveCount: 0 })
      }

      const logs = await prisma.actionLog.findMany({
        where: { resource: 'picking-wave', resourceId: { in: waveIds } },
        select: { resourceId: true, userName: true, createdAt: true, changes: true },
        orderBy: { createdAt: 'asc' },
      })

      const byWave: Record<string, Record<string, PrintMark>> = {}
      let legacyCount = 0

      for (const log of logs) {
        const wid = log.resourceId
        if (!wid) continue
        const meta = log.changes as { print?: { docType?: string }; printLogOnly?: boolean } | null
        // print-log 写的那条是给操作记录面板看的人类可读条目，与 pick-lock 描述
        // 同一次打印。既不计次数，也不该混进 legacyCount。
        if (meta?.printLogOnly) continue
        const print = meta?.print
        if (!print?.docType) {
          // 老日志（无结构化段）或非打印动作（手动锁定/解锁）。
          // 这两者在老数据里分不开，所以只做计数提示，不冒充"已打印"。
          legacyCount++
          continue
        }
        const slot = (byWave[wid] ??= {})
        const prev = slot[print.docType]
        slot[print.docType] = {
          count: (prev?.count ?? 0) + 1,
          lastAt: log.createdAt.toISOString(),
          lastBy: log.userName || '—',
        }
      }

      return NextResponse.json({
        date,
        waves: byWave,
        legacyCount,
        printedWaveCount: Object.keys(byWave).length,
        totalWaveCount: waveIds.length,
      })
    } catch (error) {
      console.error('[GET /api/waves/print-status]', error)
      return NextResponse.json({ error: '获取打印状态失败' }, { status: 500 })
    }
  }, { require: 'print.center.access' })
}
