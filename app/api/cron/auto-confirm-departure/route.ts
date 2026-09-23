import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { dispatchWave, businessTodayDateOnly } from '@/lib/wave-dispatch'

/**
 * /api/cron/auto-confirm-departure — 22 点自动兜底「确认出发」
 * ============================================================================
 * 触发方式与 app/api/cron/generate-statements/route.ts、backup-database 一致：
 * droplet 上 systemd timer（见 deploy/droplet/systemd/veggie-auto-dispatch.*）
 * POST 本路由并带 x-cron-secret header，不引入任何云平台专属调度依赖。
 *
 * 业务背景：调度/运营人员本应在每天下班前手动点「确认全部出发」，这里是忘记点
 * （请假/下班晚了）时的兜底——22 点这个时间点，当天排的车肯定都已经出发了。
 *
 * 扫描范围是「今天往前 SCAN_LOOKBACK_DAYS 天 ≤ waveDate ≤ 今天（都柏林业务日）」而不只是
 * "今天"：万一某天完全没人手动确认，批次会积压在"待出发"状态里，第二天/第三天的自动
 * 兜底要能把历史遗留的一并补上，不能只兜当天让漏掉的批次永远卡住出不去。
 *
 * 下界不是无限往前扫——/code-review high 指出：如果无下界，第一次上线这个 cron 时，
 * 生产库里任何历史遗留的"dispatchedAt 为空但一直没人处理"的老波次（不管是几个月前的
 * 脏数据还是被遗忘的测试波次）都会被一次性当成"刚出发"处理，静默重写历史订单的状态和
 * 交货日期、还各生成一条 Trip。业务场景是"忘了点、隔几天才想起来"，不是"永远往回找"，
 * 30 天足够覆盖任何请假/连续假期的场景，同时挡住无边界扫描的风险。
 *
 * 逐个波次独立处理、互不影响：单个波次失败（比如缺排程日期）不能让其余波次也跟着
 * 兜底失败，做法参考 generate-statements 对每个客户单独 try/catch 的写法。
 */
const SCAN_LOOKBACK_DAYS = 30

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

    const candidates = await prisma.pickingWave.findMany({
      where: { dispatchedAt: null, waveDate: { gte: lookbackStart, lte: todayStart } },
      select: { id: true, name: true, orderIds: true },
    })
    const withOrders = candidates.filter(w => w.orderIds.length > 0)

    const results: Array<{ waveId: string; waveName: string | null; status: 'dispatched' | 'skipped' | 'failed'; detail: string }> = []

    for (const w of withOrders) {
      try {
        const r = await dispatchWave(w.id)
        if (r.ok) {
          results.push({ waveId: w.id, waveName: w.name, status: 'dispatched', detail: `${r.updatedCount} 个订单交货日期=${r.deliveryDate.toISOString().slice(0, 10)}、状态转 IN_DELIVERY` })
        } else {
          results.push({ waveId: w.id, waveName: w.name, status: 'skipped', detail: r.reason })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        results.push({ waveId: w.id, waveName: w.name, status: 'failed', detail: message })
        console.error('[POST /api/cron/auto-confirm-departure]', w.id, e)
      }
    }

    return NextResponse.json({
      scannedBusinessDate: today,
      total: withOrders.length,
      dispatched: results.filter(r => r.status === 'dispatched').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    })
  } catch (error) {
    console.error('[POST /api/cron/auto-confirm-departure]', error)
    const message = error instanceof Error ? error.message : '自动确认出发失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
