import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 客户门户左侧分类导航
 *
 * `ProductCategory` 是采购/仓库用的内部分类（对应温区、采购节奏），里面混杂着
 * 一批不该给客户看的系统/测试类目（"All"、"Stockable"、"Saleable"、"TEST" 等，
 * 来自 Odoo 导入历史），这里按名单过滤掉，只保留看起来像真实商品分类的那些。
 * 这是 20260926 的临时做法——没有另建一套"客户可见分类"，先复用现有数据跑起来，
 * 过滤名单需要跟着数据变化维护。
 */
const HIDDEN_CATEGORY_NAMES = new Set([
  'all', 'stockable', 'saleable', 'test', 'all / stockable /frozen',
])

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const grouped = await prisma.product.groupBy({
        by: ['categoryId'],
        where: { status: 'ACTIVE', categoryId: { not: null } },
        _count: { _all: true },
      })

      const categoryIds = grouped.map((g) => g.categoryId).filter((id): id is string => !!id)
      const categories = await prisma.productCategory.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true, nameZh: true },
      })
      const byId = new Map(categories.map((c) => [c.id, c]))

      const result = grouped
        .map((g) => {
          const cat = g.categoryId ? byId.get(g.categoryId) : null
          if (!cat) return null
          if (HIDDEN_CATEGORY_NAMES.has(cat.name.trim().toLowerCase())) return null
          return { id: cat.id, name: cat.name, nameZh: cat.nameZh, count: g._count._all }
        })
        .filter((c): c is { id: string; name: string; nameZh: string | null; count: number } => !!c)
        .sort((a, b) => b.count - a.count)

      return NextResponse.json(serializeApi(result))
    } catch (error) {
      console.error('[GET /api/customer-portal/categories]', error)
      return NextResponse.json({ error: '获取分类失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
