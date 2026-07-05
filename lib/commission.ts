import { prisma } from '@/lib/db'
import { Prisma } from '@/lib/generated/prisma/client'

type Decimal = Prisma.Decimal
const Decimal = Prisma.Decimal

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
 * 计算某订单的提成明细（实时计算，未冻结时使用）。
 * 公式：件提成 + 客户固定费 + 实送税前额 × commissionRate
 *
 * - 件提成 = Σ(line.commissionPrice × line.deliveredQty)
 * - 客户固定费 = order.commissionFixed ?? 0
 * - 实送税前额 = Σ(line.unitPrice × line.deliveredQty)
 * - commissionRate = order.commissionRate ?? 0
 */
export async function calcOrderCommission(orderId: string): Promise<{
  itemTotal: Decimal
  fixedFee: Decimal
  rateTotal: Decimal
  grandTotal: Decimal
}> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      commissionRate: true,
      commissionFixed: true,
      lines: {
        select: {
          commissionPrice: true,
          deliveredQty: true,
          unitPrice: true,
        },
      },
    },
  })

  let itemTotal = new Decimal(0)
  let deliveredSubtotal = new Decimal(0)

  for (const line of order.lines) {
    const dQty = new Decimal(line.deliveredQty ?? 0)
    if (line.commissionPrice) {
      itemTotal = itemTotal.add(line.commissionPrice.mul(dQty))
    }
    if (line.unitPrice) {
      deliveredSubtotal = deliveredSubtotal.add(line.unitPrice.mul(dQty))
    }
  }

  const fixedFee = order.commissionFixed ?? new Decimal(0)
  const rate = order.commissionRate ?? new Decimal(0)
  const rateTotal = deliveredSubtotal.mul(rate)
  const grandTotal = itemTotal.add(fixedFee).add(rateTotal)

  return { itemTotal, fixedFee, rateTotal, grandTotal }
}

/**
 * 冻结某 Trip 下所有订单的提成总额，写入 order.driverCommissionTotal。
 * TODO: Stage 4 实现，由 app/api/trips/[id]/verify/route.ts 的 POST 事务调用。
 */
export async function freezeTripCommission(
  tripId: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<void> {
  // Stage 4 实现
  throw new Error('freezeTripCommission not yet implemented — see Stage 4')
}
