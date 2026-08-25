import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withCachedGet } from '@/lib/http-cache'

// 供商品列表页多选列筛选(UoM/Created by/Last Updated by)渲染选项用。
// 只取去重后的少量值，不拉整表，符合"列筛选不全量拉取"的约束。
// 20260825 合表重构前挂在已删除的 /api/product-templates/filter-options，现搬回 /api/products。
export async function GET(req: Request) {
  return withCachedGet(req, async () => {
    try {
      const [uoms, createdByRows, updatedByRows] = await Promise.all([
        prisma.uom.findMany({ select: { name: true, nameZh: true }, orderBy: { name: 'asc' } }),
        prisma.product.findMany({ distinct: ['createdBy'], select: { createdBy: true } }),
        prisma.product.findMany({ distinct: ['updatedBy'], select: { updatedBy: true } }),
      ])
      return NextResponse.json({
        uomName: uoms.map(u => u.nameZh ?? u.name),
        createdBy: createdByRows.map(r => r.createdBy).filter((v): v is string => !!v),
        updatedBy: updatedByRows.map(r => r.updatedBy).filter((v): v is string => !!v),
      })
    } catch (error) {
      console.error('[GET /api/products/filter-options]', error)
      return NextResponse.json({ error: '获取筛选选项失败' }, { status: 500 })
    }
  })
}
