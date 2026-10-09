import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { loadCustomerFromRestaurantId } from '@/lib/server-pricing'
import { buildCustomerProductCards } from '@/lib/customer-portal-products'

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100
// 一次"再来一单"/收藏清单最多几百个品类不现实地会超过这个数，留够余量，
// 免得客户单子行数多一点就有商品被悄悄截掉、被误判成"已下架"
const MAX_IDS_LOOKUP = 500

/** parseInt 对非数字输入返回 NaN，NaN 传进 Prisma skip/take 会直接抛异常——先兜底成合法整数 */
function parsePositiveInt(raw: string | null, fallback: number): number {
  const n = raw == null ? NaN : parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const PRODUCT_INCLUDE = { uom: { select: { id: true, name: true } as const } } as const

/**
 * P1-2: 客户小程序 — 商品目录（含客户专属价格）
 *
 * GET /api/customer-portal/products
 *   - 需要 RESTAURANT 角色（客户登录后自动获得）
 *   - 根据 JWT 中 userId 解析出 Customer，计算每个商品的客户专属价格
 *
 * 两种模式：
 *   ?ids=a,b,c   — 定向查询（"再来一单"核对历史订单里的商品现价/是否还在售），
 *                  不受 status=ACTIVE 限制、不分页，好让调用方判断"这个商品下架了"
 *   ?page=&pageSize=&search=&categoryId=&productId=  — 分页浏览（首页商品网格），只返回上架商品；
 *                  productId 精确定位某一个商品（banner 点商品跳转用，避免同名商品搜错）
 *   都不传          — 等价于 page=1
 */
export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const customer = await loadCustomerFromRestaurantId(prisma, user.userId)
      if (!customer) {
        return NextResponse.json(
          { error: '未找到关联客户信息，请联系管理员' },
          { status: 403 },
        )
      }

      const { searchParams } = new URL(req.url)
      const idsParam = searchParams.get('ids')?.trim()

      const meta = {
        customerId: customer.id,
        customerName: customer.name,
        priceType: customer.priceType ?? 'multi',
        paymentTerm: customer.paymentTerm ?? 'cash',
      }

      if (idsParam) {
        const ids = [...new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS_LOOKUP)
        const products = await prisma.product.findMany({
          // 按 id 回查(购物车/常购卡片)也只返回可售的，取消 Can be Sold 的商品客户端看不到也下不了单
          where: { id: { in: ids }, canBeSold: true },
          include: PRODUCT_INCLUDE,
        })
        const cards = await buildCustomerProductCards(prisma, customer, products)
        return NextResponse.json(serializeApi({ ...meta, products: cards }))
      }

      const page = parsePositiveInt(searchParams.get('page'), 1)
      const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE))
      const search = searchParams.get('search')?.trim()
      const categoryId = searchParams.get('categoryId')?.trim()
      // 20260927（code-review 发现）：banner"跳转到商品"原来靠把商品名塞进 search 框实现，
      // 同名商品（本库有过 60+ 组重名，见 product-dedup-merge 记录）会连带搜出别的商品。
      // 精确按 id 命中，跳过名字这层不可靠的中间层。
      const productId = searchParams.get('productId')?.trim()

      const where = {
        status: 'ACTIVE' as const,
        // 不可售(Can be Sold 未勾)的商品不出现在客户下单目录里(20261009)
        canBeSold: true,
        ...(productId ? { id: productId } : {}),
        ...(categoryId ? { categoryId } : {}),
        // 20260926（code-review 发现）：`spec` 是废弃字段，绝大多数商品早已清空（历史数据见
        // order-line-description.ts 的说明），客户搜索框里输入的规格文字实际来自 `saleDescription`
        // （lineDescription() 的优先取值），漏了它会导致搜规格词基本搜不到东西。
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
          include: PRODUCT_INCLUDE,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])

      const cards = await buildCustomerProductCards(prisma, customer, products)

      return NextResponse.json(serializeApi({
        ...meta,
        products: cards,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }))
    } catch (error) {
      console.error('[GET /api/customer-portal/products]', error)
      return NextResponse.json({ error: '获取商品目录失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
