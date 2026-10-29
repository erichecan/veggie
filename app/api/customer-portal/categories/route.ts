import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { listCustomerFacingCategories } from '@/lib/customer-facing-categories'

/**
 * 客户门户左侧分类导航。过滤名单与聚合逻辑见 lib/customer-facing-categories.ts
 * （/shop 匿名浏览的分类导航共用同一份，不要各抄一份）。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      // 与门户商品列表同一可见口径（可售 + 在门户显示），否则分类计数里会算进客户看不到的商品
      const result = await listCustomerFacingCategories({ canBeSold: true, showInPortal: true })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      console.error('[GET /api/customer-portal/categories]', error)
      return NextResponse.json({ error: '获取分类失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
