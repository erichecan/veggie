import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withCachedGet } from '@/lib/http-cache'

// 供客户列表页列筛选(Last Updated by)渲染选项用，同 /api/products/filter-options 的模式：
// 只取去重后的少量值，不拉整表。
export async function GET(req: Request) {
  return withCachedGet(req, async () => {
    try {
      const updatedByRows = await prisma.customer.findMany({
        distinct: ['updatedBy'],
        select: { updatedBy: true },
      })
      return NextResponse.json({
        updatedBy: updatedByRows.map(r => r.updatedBy).filter((v): v is string => !!v),
      })
    } catch (error) {
      console.error('[GET /api/customers/filter-options]', error)
      return NextResponse.json({ error: '获取筛选选项失败' }, { status: 500 })
    }
  })
}
