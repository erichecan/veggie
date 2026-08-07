import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildFacetWhere } from '@/lib/facet-sql'
import { CUSTOMER_FACET_DEFS } from '@/lib/facets/customers'
import { writeLog } from '@/lib/action-log'
import { withAuth, tryAuth, effectiveRoles } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

// 只读展示兼容层：salesUser 关联展平成 salesman 字符串,方便旧的只读页面继续显示业务员姓名
function attachSalesmanDisplay<T extends { salesUser?: { id: string; name: string } | null }>(customers: T[]): (T & { salesman: string | null })[] {
  return customers.map((c) => ({ ...c, salesman: c.salesUser?.name ?? null }))
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const rawPageSize = parseInt(searchParams.get('pageSize') ?? '0', 10)
    // rawPageSize=0 (no param or explicit 0) → legacy flat-array response for existing consumers
    const paginated = rawPageSize > 0
    const pageSize = paginated ? Math.min(200, Math.max(1, rawPageSize)) : 0
    const search = searchParams.get('search') ?? ''
    const createdFrom = searchParams.get('createdFrom') ?? ''
    const createdTo = searchParams.get('createdTo') ?? ''
    const paymentTermFilter = searchParams.get('paymentTerm') ?? ''
    const pricelistFilter = searchParams.get('pricelistId') ?? ''
    const minOrderCount = parseInt(searchParams.get('minOrderCount') ?? '0', 10)
    const includeArchived = searchParams.get('includeArchived') === '1'

    // ids=id1,id2,... → 直接按 ID 列表查（跳过其他过滤，用于行程页批量查地址）
    const idsParam = searchParams.get('ids')
    if (idsParam) {
      const ids = idsParam.split(',').filter(Boolean)
      const customers = await prisma.customer.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, address: true, street: true, street2: true, city: true, zip: true },
      })
      return NextResponse.json(serializeApi(customers))
    }

    // Default: only active customers (isActive = true). Pass includeArchived=1 to see all.
    // isActive is non-nullable Boolean in schema — { isActive: null } is invalid Prisma syntax.
    const andConditions: Record<string, unknown>[] = []
    if (!includeArchived) {
      andConditions.push({ isActive: true })
    }
    const isVendorParam = searchParams.get('isVendor')
    if (isVendorParam === 'true' || isVendorParam === '1') {
      andConditions.push({ isVendor: true })
    }
    if (search) {
      andConditions.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { vatNumber: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      })
    }
    // 分面搜索：同维度 OR、跨维度 AND
    andConditions.push(...await buildFacetWhere(searchParams, CUSTOMER_FACET_DEFS))

    // P1-3: SALES 角色自动过滤 — 只看自己名下的客户。
    // ⚠️ 必须在构造 where 之前 push：where 为空数组时会退化成 {}，
    // 此后再往 andConditions 里 push 就完全不生效（includeArchived=1 且无其他筛选时正是这种情况，
    // 隔离会静默失效）。20260802 审计发现，故上移。
    const caller = await tryAuth(req)
    if (caller) {
      const roles = effectiveRoles(caller)
      if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
        andConditions.push({ salesUserId: caller.userId })
      }
    }

    const where: Record<string, unknown> = andConditions.length > 0 ? { AND: andConditions } : {}
    if (createdFrom || createdTo) {
      where.createdAt = {
        ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
        ...(createdTo ? { lte: new Date(createdTo + 'T23:59:59.999Z') } : {}),
      }
    }
    if (paymentTermFilter) where.paymentTerm = paymentTermFilter
    if (pricelistFilter) where.pricelists = { some: { pricelistId: pricelistFilter } }

    // 购买频次：近30天订单数 >= N
    // Order.restaurantId → User.id (RESTAURANT role) → User.customerId → Customer.id
    if (minOrderCount > 0) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const orderGroups = await prisma.order.groupBy({
        by: ['restaurantId'],
        where: { createdAt: { gte: thirtyDaysAgo } },
        _count: { id: true },
        having: { id: { _count: { gte: minOrderCount } } },
      })
      const restaurantIds = orderGroups.map(r => r.restaurantId)
      const users = await prisma.user.findMany({
        where: { id: { in: restaurantIds }, customerId: { not: null } },
        select: { customerId: true },
      })
      const eligibleIds = users.map(u => u.customerId).filter(Boolean) as string[]
      if (eligibleIds.length === 0) {
        return NextResponse.json({ data: [], total: 0, page, pageSize, totalPages: 0 })
      }
      where.id = { in: eligibleIds }
    }

    // slim=1 → skip specialPrices JOIN (for dropdowns that don't need pricing details)
    const slim = searchParams.get('slim') === '1'

    // Legacy: no pageSize param → return flat array (backward-compatible for invoices/orders/pricing pages)
    if (!paginated) {
      if (slim) {
        const customers = await prisma.customer.findMany({
          where,
          select: { id: true, name: true, email: true, phone: true, address: true, street: true, street2: true, city: true, zip: true, paymentTerm: true, pricelists: { select: { pricelistId: true, sequence: true }, orderBy: { sequence: 'asc' } }, priceType: true, creditLimit: true, isActive: true, salesUserId: true, salesUser: { select: { id: true, name: true } } },
          orderBy: { name: 'asc' },
        })
        return NextResponse.json(serializeApi(attachSalesmanDisplay(customers)))
      }
      const customers = await prisma.customer.findMany({
        where,
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
      })
      return NextResponse.json(serializeApi(attachSalesmanDisplay(customers)))
    }

    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return NextResponse.json(serializeApi({
      data: attachSalesmanDisplay(customers),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }))
  } catch (error) {
    console.error('[GET /api/customers]', error)
    return NextResponse.json({ error: '获取客户失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, pricelistIds, ...data } = await req.json()
      const customer = await prisma.customer.create({
        data: {
          ...data,
          specialPrices: specialPrices?.length
            ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: any) => sp) }
            : undefined,
          pricelists: pricelistIds?.length
            ? { create: pricelistIds.map((pricelistId: string, idx: number) => ({ pricelistId, sequence: idx + 1 })) }
            : undefined,
        },
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'customer', resourceId: customer.id,
        detail: `创建客户: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(attachSalesmanDisplay([customer])[0]), { status: 201 })
    } catch (error) {
      console.error('[POST /api/customers]', error)
      return NextResponse.json({ error: '创建客户失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'SALES', 'EXTERNAL_SALES'])
}
