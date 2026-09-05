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

    // 列头排序（20260905 改成整表排序，不再是"只排当前页"）：客户名/业务员/价格表/
    // Price Type/最后修改时间这五列点了表头就要对全部 1590 条生效，跟 Odoo 表现一致——
    // 之前前端 sortRows() 只对已经分页取回的 20 条重新排一遍，翻页后顺序照旧乱。
    const sortKey = searchParams.get('sortKey') ?? ''
    const sortDir: 'asc' | 'desc' = searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc'
    const SIMPLE_SORT: Record<string, object> = {
      name: { name: sortDir },
      priceType: { priceType: sortDir },
      updatedAt: { updatedAt: sortDir },
      salesman: { salesUser: { name: sortDir } },
    }

    // 两个分支查出的记录形状必须一致（都带 specialPrices/pricelists/salesUser），
    // 抽成具名函数才能让 TS 推出正确的 include 后类型——直接标注
    // Awaited<ReturnType<typeof prisma.customer.findMany>> 会丢掉 include 信息
    const fetchByIds = (ids: string[]) => prisma.customer.findMany({
      where: { id: { in: ids } },
      include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' as const } }, salesUser: { select: { id: true, name: true } } },
    })

    let total: number
    let customers: Awaited<ReturnType<typeof fetchByIds>>
    if (sortKey === 'primaryPricelistId') {
      // Pricelist 列显示的是"主价格表"（sequence 最小那条）的名字，是跨两张表的派生值，
      // Prisma 的关系 orderBy 排不了"多对多关系里 sequence=1 那条的对端名字"——只能
      // 先在内存里按名字排出全量顺序，再按这一页的 id 去精确查一次完整记录。
      const candidates = await prisma.customer.findMany({
        where,
        select: { id: true, pricelists: { select: { pricelistId: true }, orderBy: { sequence: 'asc' }, take: 1 } },
      })
      const pricelistNames = new Map(
        (await prisma.odooPricelist.findMany({ select: { id: true, name: true } })).map(p => [p.id, p.name]),
      )
      const withKey = candidates.map(c => ({
        id: c.id,
        key: (c.pricelists[0] ? pricelistNames.get(c.pricelists[0].pricelistId) : undefined) ?? '',
      }))
      withKey.sort((a, b) => sortDir === 'asc' ? a.key.localeCompare(b.key, 'en') : b.key.localeCompare(a.key, 'en'))
      total = withKey.length
      const pageIds = withKey.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(w => w.id)
      const orderIndex = new Map(pageIds.map((id, i) => [id, i]))
      const rows = await fetchByIds(pageIds)
      customers = rows.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
    } else {
      const orderBy = SIMPLE_SORT[sortKey] ?? { name: 'asc' }
      const [totalCount, rows] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where,
          include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' as const } }, salesUser: { select: { id: true, name: true } } },
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      total = totalCount
      // findMany 的 include 跟 fetchByIds 完全一致，运行时形状相同——
      // 只是这里多传了 orderBy/skip/take，TS 的重载推断对不上 fetchByIds 的返回类型，
      // 两个分支共用同一个 customers 变量需要这一处强制对齐
      customers = rows as Awaited<ReturnType<typeof fetchByIds>>
    }

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
