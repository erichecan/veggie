import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { CategoryTreeError } from '@/lib/product-category-tree'
import { writeProductCategory } from '@/lib/product-category-write'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const cat = await writeProductCategory(id, data)
      return NextResponse.json(serializeApi(cat))
    } catch (error) {
      if (error instanceof CategoryTreeError) return NextResponse.json({ error: error.message }, { status: 400 })
      console.error('[PUT /api/product-categories/[id]]', error)
      return NextResponse.json({ error: '更新分类失败' }, { status: 500 })
    }
  }, { require: 'master.product_category.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(610050002::bigint)`
        const children = await tx.productCategory.count({ where: { parentId: id } })
        const products = await tx.product.count({ where: { categoryId: id } })
        if (children || products) throw new CategoryTreeError('请先移走子分类和商品，再删除分类 / Move child categories and products before deleting')
        await tx.productCategory.delete({ where: { id } })
      }, { timeout: 15_000 })
      return NextResponse.json({ ok: true })
    } catch (error) {
      if (error instanceof CategoryTreeError) return NextResponse.json({ error: error.message }, { status: 409 })
      console.error('[DELETE /api/product-categories/[id]]', error)
      return NextResponse.json({ error: '删除分类失败' }, { status: 500 })
    }
  }, { require: 'master.product_category.delete' })
}
