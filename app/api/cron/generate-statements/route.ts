import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateStatement, computeSettlementPeriod, StatementInputError } from '@/lib/statements'

/**
 * /api/cron/generate-statements — 按客户结算周期自动生成对账单
 * ============================================================================
 * 触发方式与 app/api/cron/backup-database/route.ts 一致：外部定时器（droplet 上
 * crontab/systemd timer 即可）POST 本路由并带 x-cron-secret header，不引入任何
 * 云平台专属调度依赖。
 *
 * 遍历 settlementCycle != 'NONE' 的客户，各自按周期算出"上一个完整周期"生成一张
 * 对账单。幂等性由 lib/statements.ts 的 generateStatement 保证 —— 同客户同期间
 * 已存在就跳过，不会因为重复触发/补跑而生成两张账。
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const customers = await prisma.customer.findMany({
      where: { settlementCycle: { in: ['WEEKLY', 'MONTHLY'] } },
      select: { id: true, name: true, settlementCycle: true },
    })

    const results: Array<{ customerId: string; customerName: string; status: 'created' | 'skipped' | 'failed'; detail: string }> = []

    for (const customer of customers) {
      const cycle = customer.settlementCycle as 'WEEKLY' | 'MONTHLY'
      const { periodStart, periodEnd } = computeSettlementPeriod(cycle)
      try {
        const result = await generateStatement(customer.id, periodStart, periodEnd)
        if (result.ok) {
          results.push({ customerId: customer.id, customerName: customer.name, status: 'created', detail: result.statement.id })
        } else if (result.reason === 'duplicate') {
          results.push({ customerId: customer.id, customerName: customer.name, status: 'skipped', detail: `已存在 ${result.existingId}` })
        } else {
          results.push({ customerId: customer.id, customerName: customer.name, status: 'failed', detail: '客户不存在（并发被删？）' })
        }
      } catch (e) {
        // 单个客户的生成失败（比如期间日期解析异常）不能让整批任务中断 ——
        // 其余客户的对账单该出还是要出。
        const message = e instanceof StatementInputError ? e.message : (e instanceof Error ? e.message : String(e))
        results.push({ customerId: customer.id, customerName: customer.name, status: 'failed', detail: message })
        console.error(`[POST /api/cron/generate-statements] customer=${customer.id}`, e)
      }
    }

    return NextResponse.json({
      total: customers.length,
      created: results.filter(r => r.status === 'created').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    })
  } catch (error) {
    console.error('[POST /api/cron/generate-statements]', error)
    const message = error instanceof Error ? error.message : '定时生成对账单失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
