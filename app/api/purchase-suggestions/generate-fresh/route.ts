import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { generateFreshDailySuggestions } from '@/lib/purchase-suggestions-fresh'

/**
 * POST /api/purchase-suggestions/generate-fresh
 * 生鲜冷冻品类·每日备货建议生成（算法见 lib/purchase-suggestions-fresh.ts）
 * 幂等：一天内重复调用会用最新数据覆盖今天已生成的 pending 建议。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const rows = await generateFreshDailySuggestions()
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase-suggestion',
        detail: `生成生鲜次日备货建议 ${rows.length} 条`,
      })
      return NextResponse.json(serializeApi({ generated: rows.length, suggestions: rows }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-suggestions/generate-fresh]', error)
      return NextResponse.json({ error: '生成生鲜备货建议失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
