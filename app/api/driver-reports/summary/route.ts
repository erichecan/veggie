import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { driverRowScope } from '@/lib/row-scope'
import {
  deriveDailyReportRange, parseReportDate,
} from '@/lib/driver-daily-report'
import {
  buildReconciliationRows, summarizeReconciliation,
  type ReportSnapshot,
} from '@/lib/driver-reconciliation'
import { toDayKey, businessTodayStart, addBusinessDays } from '@/lib/analytics/metrics'

/**
 * GET /api/driver-reports/summary — 司机对账状态统计（台账 C10）
 * ============================================================================
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD&driverId=<可选>
 *
 * 返回按「司机 × 业务日」的对账行：状态（未提交/待确认/已确认）、申报值、系统值、差异。
 * 财务的确认动作走 C9 已有的 `PUT /api/driver-reports/daily`，本接口只读。
 *
 * **「未提交」从行程派生**：只查日报表看到的永远是报过账的人，而要找的正是
 * 出了车没报账的那个（详见 `lib/driver-reconciliation.ts` 文件头）。
 *
 * 权限沿用 `finance.settlement.read` —— 与 C8/C9 同一件事的不同视图，
 * 另开权限点只会得到一个没人有的开关（derive 不认新 handler，C4/H3 各踩过一次）。
 */

/** 区间上限。放开到 400 天没有意义：这张表是按天逐行列的，一屏看不完就该缩区间 */
const MAX_RANGE_DAYS = 92
const DEFAULT_RANGE_DAYS = 7

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { searchParams } = new URL(req.url)

      // 默认最近 7 个业务日（含今天）。业务日=都柏林，不是进程时区 ——
      // 生产容器跑 UTC，用 `setHours(0,0,0,0)` 会在夏令时期间整体偏一天（D8 实测 1.27% 的单）
      const today = toDayKey(businessTodayStart())
      const to = parseReportDate(searchParams.get('to')) ?? today
      const from = parseReportDate(searchParams.get('from'))
        ?? toDayKey(addBusinessDays(businessTodayStart(), -(DEFAULT_RANGE_DAYS - 1)))

      if (from > to) {
        return NextResponse.json({ error: 'from 不能晚于 to' }, { status: 400 })
      }
      const spanDays =
        Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
      if (spanDays > MAX_RANGE_DAYS) {
        return NextResponse.json(
          { error: `查询区间最多 ${MAX_RANGE_DAYS} 天，当前 ${spanDays} 天` }, { status: 400 },
        )
      }

      // 行级隔离：只挂 DRIVER 的人一律被钉在自己身上，传别人的 driverId 也没用
      // （与 `/api/trips`、C8 同一套）。管理岗可指定看某一个司机
      const scope = driverRowScope(user)
      const requested = searchParams.get('driverId')?.trim() || null
      const driverIds = scope ? [scope.userId] : (requested ? [requested] : undefined)

      const derived = await deriveDailyReportRange(prisma, { from, to, driverIds })

      const reportRows = await prisma.driverDailyReport.findMany({
        where: {
          reportDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
          ...(driverIds ? { driverId: { in: driverIds } } : {}),
        },
        orderBy: { reportDate: 'desc' },
      })

      const reports: ReportSnapshot[] = reportRows.map(r => ({
        id: r.id,
        driverId: r.driverId,
        // reportDate 是 date 列，存的就是那一天。用 toISOString 切片而不是本地化格式化 ——
        // 后者会按进程时区把 00:00 渲染成前一天
        reportDate: r.reportDate.toISOString().slice(0, 10),
        cashCollected: Number(r.cashCollected),
        orderTotal: Number(r.orderTotal),
        returnCount: r.returnCount,
        exchangeCount: r.exchangeCount,
        status: r.status,
        note: r.note,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        submittedByName: r.submittedByName,
        confirmedAt: r.confirmedAt?.toISOString() ?? null,
        confirmedByName: r.confirmedByName,
      }))

      // 司机姓名取 User —— C6 定的司机身份唯一真相。用 Trip.driverName 那份快照的话，
      // 改过名的司机会在同一张表里裂成两行
      const ids = new Set<string>([...reports.map(r => r.driverId)])
      for (const key of derived.keys()) ids.add(key.slice(0, key.indexOf('|')))
      const users = ids.size > 0
        ? await prisma.user.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, name: true, email: true },
          })
        : []
      const driverName = new Map(users.map(u => [u.id, u.name || u.email || u.id]))

      const rows = buildReconciliationRows(derived, reports, driverName)

      return NextResponse.json(serializeApi({
        from, to,
        rows,
        summary: summarizeReconciliation(rows),
      }))
    } catch (error) {
      console.error('[GET /api/driver-reports/summary]', error)
      return NextResponse.json({ error: '获取司机对账统计失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
