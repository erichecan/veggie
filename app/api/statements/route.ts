import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * P1-1: 财务对账单
 *
 * GET  /api/statements        — 列表（支持 ?status=, ?customerId= 过滤）
 * POST /api/statements        — 生成对账单（自动计算销售/付款汇总）
 */

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const url = new URL(req.url)
      const status = url.searchParams.get('status')
      const customerId = url.searchParams.get('customerId')
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50))

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (customerId) where.customerId = customerId

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
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}

/**
 * POST /api/statements — 生成对账单
 *
 * 请求体：
 *   { customerId, periodStart (ISO date), periodEnd (ISO date) }
 *
 * 算法：
 *   1. 查上期同客户的 closingBalance 作为 openingBalance
 *   2. 查该周期内该客户所有 CONFIRMED+ 订单 → totalSales
 *   3. 查该周期内该客户所有已付款发票 → totalPayments
 *   4. closingBalance = openingBalance + totalSales - totalPayments
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

      const start = new Date(periodStart)
      const end = new Date(periodEnd)

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return NextResponse.json({ error: '日期格式无效' }, { status: 400 })
      }
      if (start >= end) {
        return NextResponse.json({ error: 'periodStart 必须早于 periodEnd' }, { status: 400 })
      }

      // 查客户信息
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true },
      })
      if (!customer) {
        return NextResponse.json({ error: '客户不存在' }, { status: 404 })
      }

      // 1. 查上期 closingBalance → 本期 openingBalance
      const lastStatement = await prisma.statement.findFirst({
        where: { customerId, periodEnd: { lt: start } },
        orderBy: { periodEnd: 'desc' },
        select: { closingBalance: true },
      })
      const openingBalance = toNum(lastStatement?.closingBalance ?? 0)

      // 2. 查该周期内该客户 CONFIRMED 及之后状态的订单
      const validStatuses = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED']
      const orders = await prisma.order.findMany({
        where: {
          restaurantId: customerId,
          status: { in: validStatuses as never[] },
          createdAt: { gte: start, lte: end },
        },
        select: { id: true, totalAmount: true },
      })

      const orderIds = orders.map(o => o.id)
      const totalSales = orders.reduce(
        (sum, o) => sum + toNum(o.totalAmount),
        0,
      )

      // 3. 期内实收 = 该客户期内 Payment 流水之和(按 paidAt)。
      //    旧实现按 invoice.status∈{PAID,PARTIAL} 求 amountPaid,但 PARTIAL 从未被设置→
      //    部分付款的 POSTED 发票被漏算;且按发票创建日而非收款日,跨期会错(P1-6/P2)。
      const periodPayments = await prisma.payment.findMany({
        where: { customerId, paidAt: { gte: start, lte: end } },
        select: { amount: true, invoiceId: true },
      })
      const totalPayments = periodPayments.reduce((sum, p) => sum + toNum(p.amount), 0)
      const invoiceIds = [...new Set(periodPayments.map(p => p.invoiceId))]

      // 4. closingBalance = openingBalance + totalSales - totalPayments
      const closingBalance = openingBalance + totalSales - totalPayments

      const statement = await prisma.statement.create({
        data: {
          customerId: customer.id,
          customerName: customer.name,
          periodStart: start,
          periodEnd: end,
          openingBalance,
          totalSales,
          totalPayments,
          closingBalance,
          orderIds,
          invoiceIds,
          status: 'draft',
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'statement', resourceId: statement.id,
        detail: `创建对账单: ${customer.name} ${periodStart}~${periodEnd}`,
      })

      return NextResponse.json(serializeApi(statement), { status: 201 })
    } catch (error) {
      console.error('[POST /api/statements]', error)
      return NextResponse.json({ error: '创建对账单失败' }, { status: 500 })
    }
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}
