import { prisma } from '@/lib/db'
import { Prisma } from '@/lib/generated/prisma/client'
import { toStockQty } from '@/lib/inventory'

type Decimal = Prisma.Decimal
const Decimal = Prisma.Decimal

/** 任意支持订单/行读写的客户端：顶层 prisma 或事务内的 tx，二者结构兼容 */
type DbClient = Prisma.TransactionClient | typeof prisma

type OrderForCommission = {
  commissionRate: Decimal | null
  commissionFixed: Decimal | null
  lines: Array<{
    productId: string
    uomId: string | null
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
      productId: true,
      uomId: true,
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
 * 按公式算出一单的提成分项与合计。
 * 公式：件提成 + 客户固定费 + 实送税前额 × commissionRate
 * 边界：整单实送量为 0（所有 deliveredQty=0）→ 固定费也不计（没去成没有辛苦费）。
 * 多单位销售(20260714)：commissionPrice 按商品"基准单位"定价；行选用非基准单位下单时
 * (如按箱)，件提成按换算系数自动放大——等价于把 deliveredQty 换算成基准单位数量再乘单价,
 * 与 lib/inventory.ts 里库存换算用的是同一套 Uom.factor 比例(toStockQty)。
 */
async function sumCommission(order: OrderForCommission, client: DbClient): Promise<{
  itemTotal: Decimal
  fixedFee: Decimal
  rateTotal: Decimal
  grandTotal: Decimal
}> {
  let itemTotal = new Decimal(0)
  let deliveredSubtotal = new Decimal(0)
  let anyDelivered = false

  for (const line of order.lines) {
    const dQty = new Decimal(line.deliveredQty ?? 0)
    if (dQty.gt(0)) anyDelivered = true
    if (line.commissionPrice) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const commissionQty = await toStockQty(client as any, line.productId, dQty.toNumber(), line.uomId)
      itemTotal = itemTotal.add(line.commissionPrice.mul(commissionQty))
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
  return sumCommission(order, prisma)
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
  const { grandTotal } = await sumCommission(order, tx)
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
    const { grandTotal } = await sumCommission(order, tx)
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
