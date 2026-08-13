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
 * PUT  { date, driverId, note? }    财务确认当日货款（台账 C9）
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


/**
 * PUT — 财务确认司机当日回传（台账 C9）
 *
 * 独立权限 `finance.settlement.confirm`：司机有 read/create 但**没有 confirm**，
 * 所以司机确认不了自己报的账（职责分离，与 G1 的交账确认同一条线）。
 *
 * 确认之后这条记录进入 `confirmed`，司机侧本来就改不了（一天一条 + 唯一约束），
 * 现在再加一道：已确认的不允许重复确认，避免两个财务各点一次留下两条互相矛盾的痕迹。
 */
export async function PUT(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as { date?: string; driverId?: string; note?: string }
      const date = parseReportDate(body.date)
      if (!date) {
        return NextResponse.json({ error: 'date 必须是 YYYY-MM-DD 格式的真实日期' }, { status: 400 })
      }
      const driverId = body.driverId?.trim()
      if (!driverId) {
        return NextResponse.json({ error: '缺少 driverId' }, { status: 400 })
      }

      const key = { driverId_reportDate: { driverId, reportDate: new Date(`${date}T00:00:00Z`) } }
      const existing = await prisma.driverDailyReport.findUnique({ where: key })
      if (!existing) {
        return NextResponse.json({ error: `司机 ${date} 还没有提交当日回传` }, { status: 404 })
      }
      if (existing.status === 'confirmed') {
        return NextResponse.json({
          error: `该回传已于 ${existing.confirmedAt?.toISOString().slice(0, 10)} 由 ${existing.confirmedByName ?? '?'} 确认过`,
        }, { status: 409 })
      }

      const updated = await prisma.driverDailyReport.update({
        where: key,
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          confirmedById: user.userId,
          confirmedByName: user.name ?? '',
          // 确认时的备注**追加**而不是覆盖司机写的那条 —— 两边说的是不同的事
          note: body.note
            ? `${existing.note ? existing.note + ' | ' : ''}财务：${String(body.note).slice(0, 300)}`
            : existing.note,
        },
      })

      // 确认那一刻的系统值一并记进日志：事后行程再被改，也能查到"确认时看到的是什么"
      const system = await deriveDailyReport(prisma, driverId, date)
      const diffs = diffReport({
        cashCollected: Number(existing.cashCollected),
        orderTotal: Number(existing.orderTotal),
        returnCount: existing.returnCount,
        exchangeCount: existing.exchangeCount,
      }, system)

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'driver-daily-report', resourceId: updated.id,
        detail: `财务确认当日回传 ${date}：申报现金 ${Number(existing.cashCollected)}` +
          ` / 系统 ${system.cashCollected}` +
          (diffs.length > 0 ? ` · ${diffs.length} 项对不上：${diffs.map(d => d.label).join('、')}` : ' · 完全一致'),
      })

      return NextResponse.json(serializeApi({ report: updated, system, diffs }))
    } catch (error) {
      console.error('[PUT /api/driver-reports/daily]', error)
      return NextResponse.json({ error: '确认当日回传失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.confirm' })
}
