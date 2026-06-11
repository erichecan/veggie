import { prisma } from '@/lib/db'

/**
 * lib/notify.ts — 业务事件通知
 * 给指定角色的所有活跃用户写入站内通知(顶栏铃铛)。
 * 失败不抛出:通知是旁路,不能影响主业务事务。
 */
export async function notifyRole(
  roles: string[],
  payload: { type: string; title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { role: { in: roles as never[] } },
          { roles: { hasSome: roles } },
        ],
      },
      select: { id: true },
    })
    if (users.length === 0) return
    await prisma.notification.createMany({
      data: users.map(u => ({
        userId: u.id,
        type: payload.type,
        title: payload.title.slice(0, 200),
        body: payload.body.slice(0, 1000),
        data: (payload.data ?? {}) as never,
      })),
    })
  } catch (e) {
    console.error('[notifyRole]', e)
  }
}

/** 订单确认后检查行内商品库存,低于阈值聚合发一条低库存通知。 */
export async function notifyLowStockAfterConfirm(
  productIds: string[],
  orderCode: string,
): Promise<void> {
  try {
    if (productIds.length === 0) return
    const low = await prisma.product.findMany({
      where: { id: { in: productIds }, active: true, qtyOnHand: { lt: 20 } },
      select: { name: true, qtyOnHand: true },
    })
    if (low.length === 0) return
    const names = low
      .slice(0, 5)
      .map(p => `${p.name}(剩 ${Number(p.qtyOnHand)})`)
      .join('、')
    await notifyRole(['OPERATOR'], {
      type: 'shortage',
      title: `低库存提醒:${low.length} 个商品库存不足 20`,
      body: `订单 ${orderCode} 确认后,${names}${low.length > 5 ? ' 等' : ''}库存偏低,请考虑补货。`,
      data: { orderCode, products: low.map(p => p.name) },
    })
  } catch (e) {
    console.error('[notifyLowStockAfterConfirm]', e)
  }
}
