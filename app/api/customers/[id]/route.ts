import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

const TRACKED_FIELDS = [
  'name', 'address', 'street', 'street2', 'city', 'state', 'zip', 'country',
  'phone', 'email', 'vatNumber', 'paymentTerm', 'creditLimit',
  'commissionRate', 'commissionFixed', 'pricelistIds', 'priceType',
  'isActive', 'isCustomer', 'isVendor', 'notes', 'externalNote',
  'defaultDriverSlotId',  // P1-4: 客户默认司机绑定
  'salesUserId',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
    })
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })
    return NextResponse.json(serializeApi({ ...customer, salesman: customer.salesUser?.name ?? null }))
  } catch (error) {
    console.error('[GET /api/customers/[id]]', error)
    return NextResponse.json({ error: '获取客户失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, pricelistIds, ...rest } = await req.json()
      // 前端 Save 会把 GET 返回的原始对象（含 salesUser 关系对象、salesman 派生字段、id/createdAt 等）
      // 整体展开进请求体；只挑白名单里真实可写的标量字段传给 Prisma，
      // 否则 salesUser 这类关系对象会让 prisma.customer.update 直接抛 PrismaClientValidationError（500）
      const data: Record<string, unknown> = {}
      for (const key of TRACKED_FIELDS) {
        if (key === 'pricelistIds') continue
        if (key in rest) data[key] = rest[key]
      }
      // 旧值（带出 pricelists 关系，供 diffChanges 比对）
      const before = await prisma.customer.findUnique({
        where: { id },
        include: { pricelists: { orderBy: { sequence: 'asc' } } },
      })
      if (!before) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      await prisma.customerSpecialPrice.deleteMany({ where: { customerId: id } })
      if (pricelistIds !== undefined) {
        await prisma.customerPricelist.deleteMany({ where: { customerId: id } })
      }
      // 关于 street/street2/state/zip/country 这五个字段：
      // schema.prisma 已新增，但 prisma generate 需要在用户本地 macOS 执行。
      // 这里用 Record<string, unknown> 兜底，如果客户端尚未 generate，
      // 则这五个字段会被 Prisma 忽略（不会报错）。
      const updateData: Record<string, unknown> = {
        ...data,
        specialPrices: specialPrices?.length
          ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: Record<string, unknown>) => sp) }
          : undefined,
        pricelists: pricelistIds?.length
          ? { create: pricelistIds.map((pricelistId: string, idx: number) => ({ pricelistId, sequence: idx + 1 })) }
          : undefined,
      }
      // SSOT: address 由地址组件后端派生(前端不再权威拼接),保证与 street/.. 一致(P2)
      const b = before as unknown as Record<string, unknown>
      const pick = (k: string) => (data[k] !== undefined ? data[k] : b[k])
      updateData.address = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .map((k) => String(pick(k) ?? '').trim()).filter(Boolean).join(', ')
      // 地址组件变更 → 清空经纬度,触发重新 geocode(否则坐标陈旧)
      const addrChanged = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .some((k) => data[k] !== undefined && String(data[k] ?? '') !== String(b[k] ?? ''))
      if (addrChanged) { updateData.latitude = null; updateData.longitude = null }
      const customer = await prisma.customer.update({
        where: { id },
        data: updateData as Parameters<typeof prisma.customer.update>[0]['data'],
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
      })
      const beforeWithPricelistIds = { ...before, pricelistIds: before.pricelists.map(p => p.pricelistId) } as unknown as Record<string, unknown>
      const afterWithPricelistIds = { ...customer, pricelistIds: customer.pricelists.map(p => p.pricelistId) } as unknown as Record<string, unknown>
      const changes = diffChanges(beforeWithPricelistIds, afterWithPricelistIds, TRACKED_FIELDS)
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'customer', resourceId: id,
        detail: `更新客户: ${data.name || id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi({ ...customer, salesman: customer.salesUser?.name ?? null }))
    } catch (error) {
      console.error('[PUT /api/customers/[id]]', error)
      return NextResponse.json({ error: '更新客户失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'SALES'])
}
