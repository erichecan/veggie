import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { rateLimit } from '@/lib/rate-limit'

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100

/** parseInt 对非数字输入返回 NaN，NaN 传进 Prisma skip/take 会直接抛异常——先兜底成合法整数 */
function parsePositiveInt(raw: string | null, fallback: number): number {
  const n = raw == null ? NaN : parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 餐厅自助下单匿名浏览入口（/shop）的商品列表。
 *
 * ⚠️ 不能复用 app/api/customer-portal/products/route.ts —— 那个接口调用
 * buildCustomerProductCards 算客户专属价格，设计上就要读价格表。这里是匿名访客，
 * 没有 Customer，所以从查询层就只 select 名称/图片/规格/分类这几个字段，
 * 不 select 任何价格（listPrice/price/standardPrice）或库存（qtyOnHand）字段，
 * 不是「算完价格再在返回前删掉」——那种做法容易因为漏删某个字段造成价格泄露
 * （2026-08-02 的 /api/customers 匿名泄露就是前车之鉴）。
 */
export async function GET(req: Request) {
  const denied = rateLimit(req, { id: 'public-catalog', max: 60, windowMs: 60_000 })
  if (denied) return denied

  try {
    const { searchParams } = new URL(req.url)
    const page = parsePositiveInt(searchParams.get('page'), 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE))
    const search = searchParams.get('search')?.trim()
    const categoryId = searchParams.get('categoryId')?.trim()

    const where = {
      status: 'ACTIVE' as const,
      canBeSold: true,
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { saleDescription: { contains: search, mode: 'insensitive' as const } },
              { spec: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true, name: true, spec: true, saleDescription: true, images: true, categoryId: true,
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return NextResponse.json(serializeApi({
      products,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }))
  } catch (error) {
    console.error('[GET /api/public/products]', error)
    return NextResponse.json({ error: '获取商品失败' }, { status: 500 })
  }
}
