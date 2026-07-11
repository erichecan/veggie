import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// 供商品列表页多选列筛选(UoM/Created by/Last Updated by)渲染选项用。
// 只取去重后的少量值，不拉整表，符合"列筛选不全量拉取"的约束。
export async function GET() {
  try {
    const [uoms, createdByRows, updatedByRows] = await Promise.all([
      prisma.uom.findMany({ select: { name: true, nameZh: true }, orderBy: { name: 'asc' } }),
      prisma.productTemplate.findMany({ distinct: ['createdBy'], select: { createdBy: true } }),
      prisma.productTemplate.findMany({ distinct: ['updatedBy'], select: { updatedBy: true } }),
    ])
    return NextResponse.json({
      uomName: uoms.map(u => u.nameZh ?? u.name),
      createdBy: createdByRows.map(r => r.createdBy).filter((v): v is string => !!v),
      updatedBy: updatedByRows.map(r => r.updatedBy).filter((v): v is string => !!v),
    })
  } catch (error) {
    console.error('[GET /api/product-templates/filter-options]', error)
    return NextResponse.json({ error: '获取筛选选项失败' }, { status: 500 })
  }
}
