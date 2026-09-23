import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import type { TripRestaurant } from '@/lib/types'

/**
 * 仓库核实（20260922）：司机上报的退换货先落 WAREHOUSE_PENDING，次日仓库工作人员
 * 去车上核对实物是否真的在、与纸质单是否一致，核实通过才转 PENDING_REVIEW 进入
 * 现有 operator/returns 销售/运营审核队列；核实不通过直接打回（REJECTED），不做
 * 多级申诉。
 *
 * 只允许对 WAREHOUSE_PENDING 状态的记录操作，其余状态一律 400——防止跳过仓库这一环
 * 直接把司机刚提交、还没人看过实物的记录推进到销售审核。
 *
 * PUT /api/trips/:id/returns/warehouse-verify
 * body: { restaurantId, productId, returnId?, action: 'verify' | 'reject', note?: string }
 *
 * `returnId` 是首选定位方式（对应 ReturnItem.id，20260922 补）：同一商品可能被
 * 分别上报两次（比如又发现一批、或历史订单补报），仅靠 productId+status 匹配
 * 会命中数组里第一条同状态记录，可能不是仓库刚打开在看的那一条。缺 returnId
 * （历史遗留、此字段上线前提交的记录）时才退回旧的 productId 匹配。
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { restaurantId, productId, returnId, action, note } = body as {
        restaurantId?: string
        productId?: string
        returnId?: string
        action?: 'verify' | 'reject'
        note?: string
      }

      if (!restaurantId || !productId || (action !== 'verify' && action !== 'reject')) {
        return NextResponse.json({ error: '缺少必填字段: restaurantId, productId, action(verify|reject)' }, { status: 400 })
      }
      if (action === 'reject' && !note?.trim()) {
        return NextResponse.json({ error: '核实不通过必须填写原因' }, { status: 400 })
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
      const rIdx = restaurants.findIndex(r => r.restaurantId === restaurantId)
      if (rIdx === -1) {
        return NextResponse.json({ error: `行程中未找到客户 ${restaurantId}` }, { status: 404 })
      }

      const restaurant = restaurants[rIdx]
      const returns = restaurant.returns ?? []
      const retIdx = returnId
        ? returns.findIndex(ret => ret.id === returnId && ret.status === 'WAREHOUSE_PENDING')
        : returns.findIndex(ret => ret.productId === productId && ret.status === 'WAREHOUSE_PENDING')
      if (retIdx === -1) {
        return NextResponse.json({ error: '未找到待仓库核实的对应退货记录（可能已被处理，或还没到仓库核实这一步）' }, { status: 400 })
      }

      const ret = returns[retIdx]
      const now = new Date().toISOString()
      returns[retIdx] = {
        ...ret,
        status: action === 'verify' ? 'PENDING_REVIEW' : 'REJECTED',
        warehouseVerifiedById: user.userId,
        warehouseVerifiedByName: user.name,
        warehouseVerifiedAt: now,
        warehouseNote: note?.trim() || undefined,
      }
      restaurants[rIdx] = { ...restaurant, returns }

      await prisma.trip.update({
        where: { id },
        data: { restaurants: restaurants as never },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `仓库核实退货: ${restaurant.restaurantName} — ${ret.productName} × ${ret.quantity} — ${action === 'verify' ? '核实通过' : `核实不通过(${note})`}`,
      })

      return NextResponse.json(serializeApi({
        message: action === 'verify' ? '已核实通过，转入销售审核' : '已标记核实不通过，退货申请已打回',
        restaurantId,
        productId,
        status: returns[retIdx].status,
      }))
    } catch (error) {
      console.error('[PUT /api/trips/[id]/returns/warehouse-verify]', error)
      return NextResponse.json({ error: '仓库核实失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.warehouse_verify' })
}
