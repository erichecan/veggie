import { prisma } from '@/lib/db'
import { Prisma, type $Enums } from '@/lib/generated/prisma/client'
import { round2 } from '@/lib/decimal-helpers'

/**
 * 订单调整行（20260913）—— 折扣/配送费/差价修正等不对应任何库存商品的金额调整。
 * ============================================================================
 * 产生背景：生产库长期靠虚构商品（price difference/Small Offer Set/Discount/
 * Deliver Service）将就实现这类需求，见 docs/20260913-consu-missing-uom-checklist.md、
 * DEV-PLAN.md。
 *
 * ⛔ Order.totalAmount 语义不变，恒等于商品行合计（税前，SSOT 见
 * sales-accounting-tax-convention 记忆）——本模块只在需要"客户实际应付总额"的场景
 * （发票/结算/司机对账）叠加调整合计，不改 totalAmount 本身。销售额/毛利/提成统计
 * 一律不读本模块，维持只看 OrderLine 的既有口径。
 */

export type OrderAdjustmentInput = {
  orderId: string
  type: $Enums.OrderAdjustmentType
  label: string
  amount: number
  note?: string | null
  createdById: string
}

/** 纯校验：说明不能为空、金额必须是非零有限数字。校验通过后返回清洗过的值。 */
export function validateAdjustmentInput(input: { label: string; amount: number }): {
  label: string
  amount: number
} {
  const label = input.label.trim()
  if (!label) throw Object.assign(new Error('调整说明不能为空'), { status: 400 })
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw Object.assign(new Error('调整金额必须是非零数字'), { status: 400 })
  }
  return { label, amount: round2(input.amount) }
}

/** 纯计算：商品小计 + 调整金额之和，四舍五入到 2 位小数。供 getOrderPayableTotal 内部使用。 */
export function computePayableTotal(totalAmount: number, adjustmentAmounts: number[]): number {
  return round2(adjustmentAmounts.reduce((sum, a) => sum + a, totalAmount))
}

export async function listAdjustments(orderId: string) {
  return prisma.orderAdjustment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  })
}

export async function createAdjustment(input: OrderAdjustmentInput) {
  const { label, amount } = validateAdjustmentInput(input)
  return prisma.orderAdjustment.create({
    data: {
      orderId: input.orderId,
      type: input.type,
      label,
      amount,
      note: input.note?.trim() || null,
      createdById: input.createdById,
    },
  })
}

/** 按 orderId 校验后删除，防止跨订单误删（adjustmentId 猜中但不属于这张单）*/
export async function deleteAdjustment(orderId: string, adjustmentId: string) {
  const existing = await prisma.orderAdjustment.findUnique({ where: { id: adjustmentId } })
  if (!existing || existing.orderId !== orderId) {
    throw Object.assign(new Error('调整记录不存在'), { status: 404 })
  }
  await prisma.orderAdjustment.delete({ where: { id: adjustmentId } })
}

/**
 * 批量版：orderId → 调整合计。供需要一次性给一批订单算应付总额的场景用
 * （打印汇总单、Trip 生成），避免 N+1 逐单查询。
 */
export async function loadAdjustmentTotalMap(orderIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (orderIds.length === 0) return map
  const rows = await prisma.orderAdjustment.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, amount: true },
  })
  for (const r of rows) {
    map.set(r.orderId, round2((map.get(r.orderId) ?? 0) + Number(r.amount)))
  }
  return map
}

/** 该订单所有调整行金额之和（可正可负，未做四舍五入前的原始值累加后再入 2 位小数）*/
export async function getAdjustmentsTotal(orderId: string): Promise<number> {
  const agg = await prisma.orderAdjustment.aggregate({
    where: { orderId },
    _sum: { amount: true },
  })
  return round2(Number(agg._sum.amount ?? new Prisma.Decimal(0)))
}

/**
 * 客户实际应付总额 = 商品小计（Order.totalAmount，税前 SSOT）+ 调整合计。
 * 发票/结算/司机对账等"客户应付/应收"场景统一调用本函数，不允许各自手写加总——
 * 否则某处漏加调整行会导致对账不平（DEV-PLAN.md 风险点 1）。
 */
export async function getOrderPayableTotal(orderId: string): Promise<number> {
  const [order, adjustments] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalAmount: true } }),
    listAdjustments(orderId),
  ])
  return computePayableTotal(Number(order.totalAmount), adjustments.map(a => Number(a.amount)))
}
