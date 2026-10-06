import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { withCachedGet } from '@/lib/http-cache'
import { buildCategoryTree, CategoryTreeError } from '@/lib/product-category-tree'
import { writeProductCategory } from '@/lib/product-category-write'

export async function GET(req: Request) {
  const load = async () => {
    try {
      const cats = await prisma.productCategory.findMany({ orderBy: { name: 'asc' } })
      return NextResponse.json(serializeApi(new URL(req.url).searchParams.get('tree') === '1' ? buildCategoryTree(cats) : cats))
    } catch (error) {
      console.error('[GET /api/product-categories]', error)
      return NextResponse.json({ error: '获取分类失败' }, { status: 500 })
    }
  }
  const params = new URL(req.url).searchParams
  return params.get('tree') === '1' || params.get('fresh') === '1' ? load() : withCachedGet(req, load)
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const cat = await writeProductCategory(null, data)
      return NextResponse.json(serializeApi(cat), { status: 201 })
    } catch (error) {
      if (error instanceof CategoryTreeError) return NextResponse.json({ error: error.message }, { status: 400 })
      console.error('[POST /api/product-categories]', error)
      return NextResponse.json({ error: '创建分类失败' }, { status: 500 })
    }
  }, { require: 'master.product_category.create' })
}
