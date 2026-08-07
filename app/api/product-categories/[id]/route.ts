import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const cat = await prisma.productCategory.update({ where: { id }, data })
      return NextResponse.json(serializeApi(cat))
    } catch (error) {
      console.error('[PUT /api/product-categories/[id]]', error)
      return NextResponse.json({ error: '更新分类失败' }, { status: 500 })
    }
  }, { require: 'master.product_category.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      await prisma.productCategory.delete({ where: { id } })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/product-categories/[id]]', error)
      return NextResponse.json({ error: '删除分类失败' }, { status: 500 })
    }
  }, { require: 'master.product_category.delete' })
}
