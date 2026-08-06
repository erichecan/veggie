import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'

/**
 * GET /api/invoices/ar-summary
 *
 * 按客户汇总**未付**发票金额（应收）。
 *
 * 由来：财务台账页原本拉 `/api/invoices` 全部 148,285 张发票（74 MB / 15 秒），
 * 只为在浏览器里跑一个循环把 `amountDue` 按客户加起来。那是把服务端该做的
 * 聚合搬到了客户端，代价是传 74 MB。这里用一句 groupBy 替掉，结果约 1,600 行。
 *
 * 口径与原前端逻辑**逐字对齐**（`finance/page.tsx` 的 arByCustomer）：
 *   只计 DRAFT + POSTED，累加 amountDue；PAID 视为 0，CANCELLED 排除。
 * 改这里等于改财务应收口径，动之前先看 docs/20260701 的税口径 SSOT。
 *
 * 返回：{ [customerId]: number }
 */
export async function GET() {
  try {
    const rows = await prisma.invoice.groupBy({
      by: ['customerId'],
      where: { status: { in: ['DRAFT', 'POSTED'] } },
      _sum: { amountDue: true },
    })

    const result: Record<string, number> = {}
    for (const r of rows) {
      const v = Number(r._sum.amountDue ?? 0)
      if (v !== 0) result[r.customerId] = v
    }

    return NextResponse.json(serializeApi(result))
  } catch (error) {
    console.error('[GET /api/invoices/ar-summary]', error)
    return NextResponse.json({ error: '获取应收汇总失败' }, { status: 500 })
  }
}
