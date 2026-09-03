import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { buildStatementsWhere } from '@/lib/statements-query'
import { generateStatement, StatementInputError } from '@/lib/statements'

/**
 * P1-1: 财务对账单
 *
 * GET  /api/statements        — 列表（支持 ?status=, ?customerId= 过滤）
 * POST /api/statements        — 生成对账单（自动计算销售/付款汇总）
 *
 * 口径与期间边界见 lib/finance/statement.ts（台账 G1 修正了四处错位）。
 */

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

      let result
      try {
        result = await generateStatement(customerId, periodStart, periodEnd)
      } catch (e) {
        if (e instanceof StatementInputError) return NextResponse.json({ error: e.message }, { status: 400 })
        throw e
      }

      if (!result.ok) {
        if (result.reason === 'not-found') return NextResponse.json({ error: '客户不存在' }, { status: 404 })
        // reason === 'duplicate'：两张并存时，下一期的期初取「上一张」会变成掷骰子，
        // 而且客户会收到两份数字不同的账。
        return NextResponse.json({
          error: `该客户此期间的对账单已存在（${result.existingId}，状态 ${result.status}）。要重出请先删除草稿。`,
          existingId: result.existingId,
        }, { status: 409 })
      }

      const { statement, openingSource } = result
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'statement', resourceId: statement.id,
        detail: `创建对账单: ${statement.customerName} ${periodStart}~${periodEnd} · 期初 €${Number(statement.openingBalance).toFixed(2)}（${openingSource === 'derived-history' ? '按历史派生' : '承上期期末'}）· 销售 €${Number(statement.totalSales).toFixed(2)} · 收款 €${Number(statement.totalPayments).toFixed(2)} · 期末 €${Number(statement.closingBalance).toFixed(2)}`,
      })

      return NextResponse.json(serializeApi({ ...statement, openingSource }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/statements]', error)
      return NextResponse.json({ error: '创建对账单失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.create' })
}
