import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { buildStatementsWhere } from '@/lib/statements-query'
import { toNum } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import {
  resolveStatementPeriod, summarizeStatement, StatementInputError,
  type StatementOrderRow,
} from '@/lib/finance/statement'

/**
 * P1-1: 财务对账单
 *
 * GET  /api/statements        — 列表（支持 ?status=, ?customerId= 过滤）
 * POST /api/statements        — 生成对账单（自动计算销售/付款汇总）
 *
 * 口径与期间边界见 lib/finance/statement.ts（台账 G1 修正了四处错位）。
 */

/** 计入对账的订单状态：确认之后的都算已发生的销售 */
const BILLABLE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const url = new URL(req.url)
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50))

      // 筛选口径抽在 lib/statements-query.ts，导出路由用同一个函数
      const where = buildStatementsWhere(url.searchParams)

      const [items, total] = await Promise.all([
        prisma.statement.findMany({
          where,
          orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.statement.count({ where }),
      ])

      return NextResponse.json(serializeApi({ items, total, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/statements]', error)
      return NextResponse.json({ error: '获取对账单列表失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.read' })
}

/**
 * POST /api/statements — 生成对账单
 *
 * 请求体：
 *   { customerId, periodStart (YYYY-MM-DD), periodEnd (YYYY-MM-DD) }
 *
 * 算法：
 *   1. openingBalance —— 优先取上一张对账单的期末（账簿连续性）；
 *      **没有上一张就从历史派生**（期前销售 − 期前收款），不再默认 0
 *   2. 期内已确认订单（按 confirmationDate，销售口径 SSOT）→ totalSales（含税）
 *   3. 期内 Payment 流水（按 paidAt）→ totalPayments，含司机交账核销的现金
 *   4. closingBalance = openingBalance + totalSales − totalPayments
 *
 * 期间是**左闭右开到末日次日 00:00**，按业务时区切 —— 原实现 `lte: end` 把末日
 * 整天切掉了（end 解析出来是当日 00:00）。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const { customerId, periodStart, periodEnd } = body

      if (!customerId || !periodStart || !periodEnd) {
        return NextResponse.json(
          { error: '缺少必填字段: customerId, periodStart, periodEnd' },
          { status: 400 },
        )
      }

      let period
      try {
        period = resolveStatementPeriod(periodStart, periodEnd)
      } catch (e) {
        if (e instanceof StatementInputError) return NextResponse.json({ error: e.message }, { status: 400 })
        throw e
      }
      const { start, endExclusive, endLabel } = period

      // 查客户信息
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true },
      })
      if (!customer) {
        return NextResponse.json({ error: '客户不存在' }, { status: 404 })
      }

      // 同客户同期间已经有一张了就别再生成第二张：两张并存时，下一期的期初
      // 取「上一张」会变成掷骰子，而且客户会收到两份数字不同的账。
      const duplicate = await prisma.statement.findFirst({
        where: { customerId, periodStart: start, periodEnd: endLabel },
        select: { id: true, status: true },
      })
      if (duplicate) {
        return NextResponse.json({
          error: `该客户此期间的对账单已存在（${duplicate.id}，状态 ${duplicate.status}）。要重出请先删除草稿。`,
          existingId: duplicate.id,
        }, { status: 409 })
      }

      const orderSelect = { id: true, code: true, confirmationDate: true, lines: { select: { subtotal: true, taxRate: true } } }
      const toRow = (o: { id: string; code?: string | null; confirmationDate?: Date | null; lines: Array<{ subtotal: unknown; taxRate: unknown }> }): StatementOrderRow =>
        ({ id: o.id, code: o.code ?? null, confirmationDate: o.confirmationDate ?? null, incTaxTotal: orderIncTaxTotal(o.lines) })

      // 1. 期初余额
      const lastStatement = await prisma.statement.findFirst({
        where: { customerId, periodEnd: { lt: start } },
        orderBy: { periodEnd: 'desc' },
        select: { closingBalance: true },
      })
      let openingBalance: number
      let openingSource: 'previous-statement' | 'derived-history'
      if (lastStatement) {
        openingBalance = toNum(lastStatement.closingBalance)
        openingSource = 'previous-statement'
      } else {
        // ⚠️ 这条分支正是「生产库第一张对账单」的场景。原实现在这里返回 0，
        // 于是客户明明欠着钱，第一张对账单却从 0 起算，期末余额直接错。
        const [priorOrders, priorPayments] = await Promise.all([
          prisma.order.findMany({
            where: { restaurantId: customerId, status: { in: BILLABLE_STATUSES as never[] }, confirmationDate: { lt: start } },
            select: orderSelect,
          }),
          prisma.payment.findMany({ where: { customerId, paidAt: { lt: start } }, select: { amount: true } }),
        ])
        const priorSales = priorOrders.reduce((s, o) => s + orderIncTaxTotal(o.lines), 0)
        const priorPaid = priorPayments.reduce((s, p) => s + toNum(p.amount), 0)
        openingBalance = Math.round((priorSales - priorPaid) * 100) / 100
        openingSource = 'derived-history'
      }

      // 2. 期内已确认订单 —— 销售口径按 confirmationDate（lib/analytics/metrics 的 SSOT），
      //    原实现按 createdAt，与数据中心的销售额对不上
      const orders = await prisma.order.findMany({
        where: {
          restaurantId: customerId,
          status: { in: BILLABLE_STATUSES as never[] },
          confirmationDate: { gte: start, lt: endExclusive },
        },
        orderBy: { confirmationDate: 'asc' },
        select: orderSelect,
      })

      // 3. 期内实收 = 该客户期内 Payment 流水之和(按 paidAt)。
      //    旧实现按 invoice.status∈{PAID,PARTIAL} 求 amountPaid,但 PARTIAL 从未被设置→
      //    部分付款的 POSTED 发票被漏算;且按发票创建日而非收款日,跨期会错(P1-6/P2)。
      const periodPayments = await prisma.payment.findMany({
        where: { customerId, paidAt: { gte: start, lt: endExclusive } },
        orderBy: { paidAt: 'asc' },
        select: { id: true, amount: true, invoiceId: true, method: true, paidAt: true, note: true },
      })

      const summary = summarizeStatement(
        openingBalance,
        orders.map(toRow),
        periodPayments.map(p => ({ id: p.id, invoiceId: p.invoiceId, amount: toNum(p.amount), method: p.method, paidAt: p.paidAt, note: p.note })),
      )

      const statement = await prisma.statement.create({
        data: {
          customerId: customer.id,
          customerName: customer.name,
          periodStart: start,
          periodEnd: endLabel,
          ...summary,
          status: 'draft',
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'statement', resourceId: statement.id,
        detail: `创建对账单: ${customer.name} ${periodStart}~${periodEnd} · 期初 €${summary.openingBalance.toFixed(2)}（${openingSource === 'derived-history' ? '按历史派生' : '承上期期末'}）· 销售 €${summary.totalSales.toFixed(2)} · 收款 €${summary.totalPayments.toFixed(2)} · 期末 €${summary.closingBalance.toFixed(2)}`,
      })

      return NextResponse.json(serializeApi({ ...statement, openingSource }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/statements]', error)
      return NextResponse.json({ error: '创建对账单失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.create' })
}
