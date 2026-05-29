import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET() {
  try {
    const cats = await prisma.productCategory.findMany({ orderBy: { name: 'asc' } })
    return NextResponse.json(serializeApi(cats))
  } catch (error) {
    console.error('[GET /api/product-categories]', error)
    return NextResponse.json({ error: '获取分类失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const cat = await prisma.productCategory.create({ data })
      return NextResponse.json(serializeApi(cat), { status: 201 })
    } catch (error) {
      console.error('[POST /api/product-categories]', error)
      return NextResponse.json({ error: '创建分类失败' }, { status: 500 })
    }
  })
}
