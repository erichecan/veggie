import { prisma } from '@/lib/db'
import { Prisma } from '@/lib/generated/prisma/client'

type Decimal = Prisma.Decimal
const Decimal = Prisma.Decimal

/** 任意支持订单/行读写的客户端：顶层 prisma 或事务内的 tx，二者结构兼容 */
type DbClient = Prisma.TransactionClient | typeof prisma

type OrderForCommission = {
  commissionRate: Decimal | null
  commissionFixed: Decimal | null
  lines: Array<{
    commissionPrice: Decimal | null
    deliveredQty: Decimal | number | null
    unitPrice: Decimal | null
  }>
}

const ORDER_COMMISSION_SELECT = {
  commissionRate: true,
  commissionFixed: true,
  lines: {
    select: {
      commissionPrice: true,
      deliveredQty: true,
      unitPrice: true,
    },
  },
} as const

/**
 * 查询某商品的件提成单价。
 * 优先取 Product.commissionPrice，fallback 到 ProductTemplate.commissionPrice。
 * 如果都没有则返回 null（代表该行不计件提成）。
 */
export async function resolveCommissionPrice(productId: string): Promise<Decimal | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      commissionPrice: true,
      template: { select: { commissionPrice: true } },
    },
  })
  if (!product) return null
  return product.commissionPrice ?? product.template?.commissionPrice ?? null
}

/**
 * 纯函数：按公式算出一单的提成分项与合计。
 * 公式：件提成 + 客户固定费 + 实送税前额 × commissionRate
 * 边界：整单实送量为 0（所有 deliveredQty=0）→ 固定费也不计（没去成没有辛苦费）。
 */
function sumCommission(order: OrderForCommission): {
  itemTotal: Decimal
  fixedFee: Decimal
  rateTotal: Decimal
  grandTotal: Decimal
} {
  let itemTotal = new Decimal(0)
  let deliveredSubtotal = new Decimal(0)
  let anyDelivered = false

  for (const line of order.lines) {
    const dQty = new Decimal(line.deliveredQty ?? 0)
    if (dQty.gt(0)) anyDelivered = true
    if (line.commissionPrice) {
      itemTotal = itemTotal.add(line.commissionPrice.mul(dQty))
    }
    if (line.unitPrice) {
      deliveredSubtotal = deliveredSubtotal.add(line.unitPrice.mul(dQty))
    }
  }

  const fixedFee = anyDelivered ? (order.commissionFixed ?? new Decimal(0)) : new Decimal(0)
  const rate = order.commissionRate ?? new Decimal(0)
  const rateTotal = deliveredSubtotal.mul(rate)
  const grandTotal = itemTotal.add(fixedFee).add(rateTotal)

  return { itemTotal, fixedFee, rateTotal, grandTotal }
}

/**
 * 计算某订单的提成明细（实时计算，未冻结时使用）。
 */
export async function calcOrderCommission(orderId: string): Promise<{
  itemTotal: Decimal
  fixedFee: Decimal
  rateTotal: Decimal
  grandTotal: Decimal
}> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: ORDER_COMMISSION_SELECT,
  })
  return sumCommission(order)
}

/**
 * 重新计算并覆盖单个订单的冻结提成快照（送达后修改 deliveredQty，如退货审核后调用）。
 * 返回新的合计金额。
 */
export async function recalcOrderCommission(
  orderId: string,
  tx: DbClient,
): Promise<Decimal> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: ORDER_COMMISSION_SELECT,
  })
  const { grandTotal } = sumCommission(order)
  await tx.order.update({
    where: { id: orderId },
    data: {
      driverCommissionTotal: grandTotal,
      commissionFrozenAt: new Date(),
    },
  })
  return grandTotal
}

/** 把 Trip.driverCommission 重新对齐为该 Trip 下各订单 driverCommissionTotal 之和 */
export async function recalcTripDriverCommission(
  tripId: string,
  tx: DbClient,
): Promise<void> {
  const trip = await tx.trip.findUnique({
    where: { id: tripId },
    select: { restaurants: true },
  })
  const restaurants = (trip?.restaurants ?? []) as unknown as Array<{ orderIds?: string[] }>
  const orderIds = restaurants.flatMap(r => r.orderIds ?? [])
  if (orderIds.length === 0) return

  const orders = await tx.order.findMany({
    where: { id: { in: orderIds } },
    select: { driverCommissionTotal: true },
  })
  const sum = orders.reduce(
    (s, o) => s.add(o.driverCommissionTotal ?? new Decimal(0)),
    new Decimal(0),
  )
  await tx.trip.update({ where: { id: tripId }, data: { driverCommission: sum } })
}

/**
 * 冻结某 Trip 下所有已送达（COMPLETED）订单的提成总额，写入 order.driverCommissionTotal +
 * commissionFrozenAt，并把 Trip.driverCommission 对齐为各单之和。
 */
export async function freezeTripCommission(
  tripId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const trip = await tx.trip.findUnique({
    where: { id: tripId },
    select: { restaurants: true },
  })
  const restaurants = (trip?.restaurants ?? []) as unknown as Array<{ orderIds?: string[] }>
  const orderIds = restaurants.flatMap(r => r.orderIds ?? [])
  if (orderIds.length === 0) return

  const orders = await tx.order.findMany({
    where: {
      id: { in: orderIds },
      status: 'COMPLETED',
    },
    select: { id: true, ...ORDER_COMMISSION_SELECT },
  })

  for (const order of orders) {
    const { grandTotal } = sumCommission(order)
    await tx.order.update({
      where: { id: order.id },
      data: {
        driverCommissionTotal: grandTotal,
        commissionFrozenAt: new Date(),
      },
    })
  }

  await recalcTripDriverCommission(tripId, tx)
}
