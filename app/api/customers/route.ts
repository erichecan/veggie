import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth, tryAuth } from '@/lib/auth'
import { buildCustomersWhere } from '@/lib/customers-query'
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

    // 筛选口径抽在 lib/customers-query.ts，导出路由(/api/export/customers)用同一个函数 ——
    // 包括行级隔离在内，导出与列表不可能分叉。
    const where = await buildCustomersWhere(searchParams, await tryAuth(req))
    if (minOrderCount > 0 && (where.id as { in?: string[] } | undefined)?.in?.length === 0) {
      return NextResponse.json({ data: [], total: 0, page, pageSize, totalPages: 0 })
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
          // 不接受客户端传入，越权改不了别人名字（同 products 路由的写法）
          updatedBy: user.name || user.email,
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
  }, { require: 'master.customer.create' })
}
