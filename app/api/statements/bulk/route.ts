
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { generateStatement, StatementInputError } from '@/lib/statements'
import { serializeApi } from '@/lib/api-serializer'

/** Generate one delivery-date statement per selected customer; failures are reported per customer. */
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const body = await req.json()
      const customerIds: string[] = [...new Set<string>((Array.isArray(body.customerIds) ? body.customerIds : [])
        .map((id: unknown) => String(id).trim()).filter(Boolean))]
      const periodStart = String(body.periodStart ?? '')
      const periodEnd = String(body.periodEnd ?? '')
      if (!customerIds.length || !periodStart || !periodEnd) {
        return NextResponse.json({ error: '请选择客户并填写账期' }, { status: 400 })
      }
      if (customerIds.length > 100) return NextResponse.json({ error: '一次最多生成 100 个客户的对账单' }, { status: 400 })

      const results = []
      for (const customerId of customerIds) {
        try {
          const result = await generateStatement(customerId, periodStart, periodEnd)
          if (!result.ok) {
            results.push({ customerId, status: result.reason === 'duplicate' ? 'duplicate' : 'not_found', ...(result.reason === 'duplicate' ? { existingId: result.existingId } : {}) })
            continue
          }
          const { statement, openingSource } = result
          await writeLog({
            userId: user.userId, userEmail: user.email, userName: user.name,
            action: 'CREATE', resource: 'statement', resourceId: statement.id,
            detail: `批量创建对账单: ${statement.customerName} ${periodStart}~${periodEnd} · 按配送日期`,
          })
          results.push({ customerId, status: 'created', statement: serializeApi({ ...statement, openingSource }) })
        } catch (error) {
          results.push({ customerId, status: 'error', error: error instanceof StatementInputError ? error.message : '生成失败' })
        }
      }
      return NextResponse.json({ results })
    } catch (error) {
      console.error('[POST /api/statements/bulk]', error)
      return apiRouteErrorResponse(error, '批量生成对账单失败')
    }
  }, { require: 'finance.statement.create' })
}
