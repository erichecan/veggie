import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { driverRowScope } from '@/lib/row-scope'
import {
  deriveDailyReport, diffReport, parseReportDate,
} from '@/lib/driver-daily-report'

/**
 * /api/driver-reports/daily — 司机每日回传（台账 C8）
 * ============================================================================
 * GET  ?date=YYYY-MM-DD&driverId=   查当日四项：系统派生值 + 已提交的申报快照 + 差异
 * POST { date, cashCollected, orderTotal, returnCount, exchangeCount, note }
 *                                   司机提交当日回传
 *
 * 行级隔离：只挂 DRIVER 的账号一律只能看/提交自己的（`driverRowScope`，与
 * `/api/trips` 同一套）。不做这层的话，司机改一个 driverId 就能替别人报账。
 */

/** 只挂 DRIVER 的人被钉在自己身上；管理岗可以指定看谁 */
function resolveDriverId(
  user: { userId: string; role?: string | null; roles?: string[] | null },
  requested: string | null,
): { driverId: string; forced: boolean } {
  const scope = driverRowScope(user)
  if (scope) return { driverId: scope.userId, forced: true }
  return { driverId: requested || user.userId, forced: false }
}

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { searchParams } = new URL(req.url)
      const date = parseReportDate(searchParams.get('date'))
      if (!date) {
        return NextResponse.json({ error: 'date 必须是 YYYY-MM-DD 格式的真实日期' }, { status: 400 })
      }
      const { driverId } = resolveDriverId(user, searchParams.get('driverId'))

      const system = await deriveDailyReport(prisma, driverId, date)
      const submitted = await prisma.driverDailyReport.findUnique({
        where: { driverId_reportDate: { driverId, reportDate: new Date(`${date}T00:00:00Z`) } },
      })

      const declared = submitted && {
        cashCollected: Number(submitted.cashCollected),
        orderTotal: Number(submitted.orderTotal),
        returnCount: submitted.returnCount,
        exchangeCount: submitted.exchangeCount,
      }

      return NextResponse.json(serializeApi({
        date,
        driverId,
        system,
        submitted,
        // 差异是**实时**算的：提交后行程被改（退货审核、补录收款）会让它变，那正是要看见的
        diffs: declared ? diffReport(declared, system) : [],
      }))
    } catch (error) {
      console.error('[GET /api/driver-reports/daily]', error)
      return NextResponse.json({ error: '获取当日回传失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as {
        date?: string; driverId?: string; note?: string
        cashCollected?: unknown; orderTotal?: unknown
        returnCount?: unknown; exchangeCount?: unknown
      }
      const date = parseReportDate(body.date)
      if (!date) {
        return NextResponse.json({ error: 'date 必须是 YYYY-MM-DD 格式的真实日期' }, { status: 400 })
      }
      const { driverId } = resolveDriverId(user, body.driverId ?? null)

      // 四项都必须显式给出 —— 缺一项就悄悄记 0 的话，"司机报了 0 笔退货"和
      // "司机没填退货"在库里长得一模一样，事后没法追责
      const fields = ['cashCollected', 'orderTotal', 'returnCount', 'exchangeCount'] as const
      const values: Record<string, number> = {}
      for (const f of fields) {
        const raw = body[f]
        if (raw === undefined || raw === null || raw === '') {
          return NextResponse.json({ error: `缺少必填项：${f}` }, { status: 400 })
        }
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json({ error: `${f} 必须是不小于 0 的数字` }, { status: 400 })
        }
        if ((f === 'returnCount' || f === 'exchangeCount') && !Number.isInteger(n)) {
          return NextResponse.json({ error: `${f} 必须是整数（数的是笔数）` }, { status: 400 })
        }
        values[f] = n
      }

      const system = await deriveDailyReport(prisma, driverId, date)

      // ⛔ 防重靠**数据库唯一约束**，不靠先查后写 —— 后者在并发下必然漏
      // （G2 的分批付款就是这么丢过钱的）。P2002 = 今天已经报过了。
      try {
        const created = await prisma.driverDailyReport.create({
          data: {
            driverId,
            reportDate: new Date(`${date}T00:00:00Z`),
            cashCollected: values.cashCollected!,
            orderTotal: values.orderTotal!,
            returnCount: values.returnCount!,
            exchangeCount: values.exchangeCount!,
            tripIds: system.tripIds,
            note: body.note ? String(body.note).slice(0, 500) : null,
            submittedById: user.userId,
            submittedByName: user.name ?? '',
          },
        })

        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'CREATE', resource: 'driver-daily-report', resourceId: created.id,
          detail: `司机当日回传 ${date}：现金 ${values.cashCollected} / 订单额 ${values.orderTotal}` +
            ` / 退货 ${values.returnCount} 笔 / 换货 ${values.exchangeCount} 笔`,
        })

        return NextResponse.json(serializeApi({
          report: created,
          system,
          diffs: diffReport(values as never, system),
        }), { status: 201 })
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'P2002') {
          const existing = await prisma.driverDailyReport.findUnique({
            where: { driverId_reportDate: { driverId, reportDate: new Date(`${date}T00:00:00Z`) } },
          })
          return NextResponse.json({
            error: `${date} 的回传已经提交过了，如需更正请联系财务`,
            existing: serializeApi(existing),
          }, { status: 409 })
        }
        throw e
      }
    } catch (error) {
      console.error('[POST /api/driver-reports/daily]', error)
      return NextResponse.json({ error: '提交当日回传失败' }, { status: 500 })
    }
    // handler 自己也要挂闸，不能只在 route-map 登记 —— 扫描器查的是这里，
    // 而 middleware 与 handler 是两层，少一层就等于"任何登录用户都能调"
  }, { require: 'finance.settlement.create' })
}
