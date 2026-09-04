import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth, tryAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'

const TRACKED_FIELDS = [
  'name', 'address', 'street', 'street2', 'city', 'state', 'zip', 'country',
  'phone', 'email', 'vatNumber', 'paymentTerm', 'creditLimit',
  'commissionRate', 'commissionFixed', 'pricelistIds', 'priceType',
  'isActive', 'isCustomer', 'isVendor', 'notes', 'externalNote',
  'defaultDriverSlotId',  // P1-4: 客户默认司机绑定
  'salesUserId',
  'settlementCycle',  // 对账单生成周期：NONE | WEEKLY | MONTHLY
  // 经纬度（C7）：原先**只能由 Google geocode 写入**，而那需要客户出钱开通的
  // API key —— 实测生产与测试库都没配，于是 1411 个客户里 0 个有坐标，
  // 地图与路线整块是死的。放开手工填写，让地图不依赖外部服务也能用起来。
  'latitude', 'longitude',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true, managerId: true } } },
    })
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })
    // 行级隔离：列表挡住了但详情没挡的话，拿到 id 依然能逐条读走
    // （id 在打印单、CSV 导出、订单详情里到处都是）。回 404 而不是 403 ——
    // 403 等于告诉对方"这个客户存在，只是不给你看"。
    if (!isRowVisible(customer, salesRowScope(await tryAuth(_req)))) {
      return NextResponse.json({ error: '客户不存在' }, { status: 404 })
    }
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
      // 只能改自己名下的客户。⛔ 必须挡在任何写动作之前 —— 下面第一句就是
      // deleteMany 专属价，先删后判的话即使最终 404，别人的数据已经被删了。
      if (!isRowVisible(before, salesRowScope(user))) {
        return NextResponse.json({ error: '客户不存在' }, { status: 404 })
      }

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
        // 不接受客户端传入，越权改不了别人名字（同 products 路由的写法）
        updatedBy: user.name || user.email,
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
      // 地址组件变更 → 清空经纬度,触发重新 geocode(否则坐标陈旧)。
      // ⚠️ 但**本次显式传了坐标就以传入值为准** —— 否则「改地址的同时填上正确坐标」
      // 这个最自然的操作会被自己清掉，手工录入永远存不进去。
      const coordsGiven = data.latitude !== undefined || data.longitude !== undefined
      const addrChanged = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .some((k) => data[k] !== undefined && String(data[k] ?? '') !== String(b[k] ?? ''))
      if (addrChanged && !coordsGiven) { updateData.latitude = null; updateData.longitude = null }
      // 坐标做范围校验：写错一位就会把餐馆丢到大西洋里，而地图不会报错只会显示错位置
      for (const [k, range] of [['latitude', 90], ['longitude', 180]] as const) {
        if (updateData[k] === undefined || updateData[k] === null) continue
        const v = Number(updateData[k])
        if (!Number.isFinite(v) || Math.abs(v) > range) {
          return NextResponse.json({ error: `${k} 超出有效范围（±${range}）` }, { status: 400 })
        }
        updateData[k] = v
      }
      if (updateData.settlementCycle !== undefined && !['NONE', 'WEEKLY', 'MONTHLY'].includes(String(updateData.settlementCycle))) {
        return NextResponse.json({ error: 'settlementCycle 只能是 NONE / WEEKLY / MONTHLY' }, { status: 400 })
      }
      const customer = await prisma.customer.update({
        where: { id },
        data: updateData as Parameters<typeof prisma.customer.update>[0]['data'],
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true, managerId: true } } },
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
  }, { require: 'master.customer.update' })
}
