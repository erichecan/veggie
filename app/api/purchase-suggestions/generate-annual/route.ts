import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { generateAnnualDryGoodsPlan } from '@/lib/purchase-suggestions-annual'

/**
 * POST /api/purchase-suggestions/generate-annual
 * 干货品类·年度采购计划生成（算法见 lib/purchase-suggestions-annual.ts）
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const rows = await generateAnnualDryGoodsPlan()
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase-suggestion',
        detail: `生成干货年度采购计划 ${rows.length} 条`,
      })
      return NextResponse.json(serializeApi({ generated: rows.length, rows }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-suggestions/generate-annual]', error)
      return NextResponse.json({ error: '生成年度采购计划失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
