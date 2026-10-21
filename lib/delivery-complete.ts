/**
 * 配送完成 → 订单回写 —— 20261020 从 waves/[id]/complete 与 trips/[id] 两处抽出来共用
 * ============================================================================
 * 调度台「标记完成」（波次）和司机端行程完成是同一件事：货送到了。两处原来各写一遍，已经开始各漏各的：
 *   - 波次完成从不把出发时生成的 Trip 置为 COMPLETED → 司机端一直挂着这趟、司机提成不结；
 *   - 只给 CONFIRMED / WAVE_ASSIGNED 的单出库，IN_DELIVERY 的单默认「出发时已扣」。但出发那一步
 *     的出库是在事务提交之后单独跑的（lib/wave-dispatch.ts），失败了订单照样是 IN_DELIVERY——
 *     这种单完成时永远不会再扣 On Hand；
 *   - 实送量对整批订单无条件覆盖成下单量，连早已完成、差异处理改过实送量的单也一起覆盖；
 *   - 草稿发票失败被 .catch 吞掉，订单完成了却没有发票，没人知道。
 *
 * 规则：
 *   1. 只处理还在途的单（CONFIRMED / WAVE_ASSIGNED / IN_DELIVERY）：实送量 = 下单量（方案 C，全送，
 *      之后按退货/差异流程覆盖），状态 → COMPLETED。
 *   2. 这些单逐张 syncOrderStock(shipping)：「目标 − 已拿」幂等，出发时扣过的不会重复扣，漏扣的补上。
 *   3. 整批订单幂等补草稿发票（已有发票的跳过）、冻结提成快照。失败的单号返回给调用方写进日志。
 */
import { prisma } from '@/lib/db'
import { Prisma } from '@/lib/generated/prisma/client'
import { syncOrderStock } from '@/lib/order-stock'
import { createDraftInvoiceForOrder, type InvoiceTx } from '@/lib/invoice-from-order'
import { recalcOrderCommission } from '@/lib/commission'

export const ORDER_COMPLETABLE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] as const

export interface CompleteOrdersResult {
  /** 本次从在途推进到 COMPLETED 的单 */
  completedIds: string[]
  /** 出库 / 发票 / 提成失败的（单号 + 原因），调用方写进操作日志 */
  failures: Array<{ orderId: string; step: 'stock' | 'invoice' | 'commission'; error: string }>
}

export async function completeDeliveredOrders(
  orderIds: string[],
  opts: { reason: string; userId?: string | null; createdBy?: string | null },
): Promise<CompleteOrdersResult> {
  const failures: CompleteOrdersResult['failures'] = []
  if (orderIds.length === 0) return { completedIds: [], failures }
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

  const completedIds = (await prisma.order.findMany({
    where: { id: { in: orderIds }, status: { in: [...ORDER_COMPLETABLE_STATUSES] } },
    select: { id: true },
  })).map(o => o.id)

  if (completedIds.length > 0) {
    await prisma.$executeRaw`
      UPDATE "OrderLine" SET "deliveredQty" = "orderedQty", "updatedAt" = NOW()
      WHERE "orderId" IN (${Prisma.join(completedIds)})
    `
    await prisma.order.updateMany({
      where: { id: { in: completedIds }, status: { in: [...ORDER_COMPLETABLE_STATUSES] } },
      data: { status: 'COMPLETED' },
    })
    for (const oid of completedIds) {
      try {
        await prisma.$transaction(tx => syncOrderStock(tx, oid, {
          shipping: true, reason: opts.reason, userId: opts.userId ?? null, createdBy: opts.createdBy ?? null,
        }), { maxWait: 10000, timeout: 60000 })
      } catch (e) {
        console.error('[delivery complete: stock]', oid, e)
        failures.push({ orderId: oid, step: 'stock', error: msg(e) })
      }
    }
  }

  // createDraftInvoiceForOrder 的 InvoiceTx 是精简版结构类型，order.findUnique 那部分对不上真实
  // PrismaClient 的泛型重载（include/select 决定返回形状），只能在这断言
  for (const oid of orderIds) {
    try {
      await createDraftInvoiceForOrder(prisma as unknown as InvoiceTx, oid)
    } catch (e) {
      console.error('[delivery complete: auto draft invoice]', oid, e)
      failures.push({ orderId: oid, step: 'invoice', error: msg(e) })
    }
  }
  for (const oid of orderIds) {
    try {
      await recalcOrderCommission(oid, prisma)
    } catch (e) {
      console.error('[delivery complete: commission freeze]', oid, e)
      failures.push({ orderId: oid, step: 'commission', error: msg(e) })
    }
  }
  return { completedIds, failures }
}

/**
 * 订单页直接把状态改成「已完成」（不经调度台 / 司机端，20261021）：原来不回填实送量，
 * 草稿发票按实送量开（lib/invoice-from-order.ts），实送量全是 0 → 发票永远开不出来、提成也是 0，
 * 这些单就一直挂在「待开票」里。按方案 C（默认全送）补上——只在整单一行实送量都没记过时才补，
 * 已经按差异/退货流程记过实送量的单不覆盖。返回是否补了。
 */
export async function fillDeliveredQtyIfUnrecorded(orderId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "OrderLine" SET "deliveredQty" = "orderedQty", "updatedAt" = NOW()
    WHERE "orderId" = ${orderId}
      AND NOT EXISTS (SELECT 1 FROM "OrderLine" x WHERE x."orderId" = ${orderId} AND x."deliveredQty" > 0)
  `
  return n > 0
}

export function describeFailures(failures: CompleteOrdersResult['failures']): string {
  if (failures.length === 0) return ''
  const label = { stock: '出库', invoice: '草稿发票', commission: '提成' } as const
  return `；⚠️ ${failures.length} 项失败：${failures.map(f => `${f.orderId} ${label[f.step]}（${f.error}）`).join('；')}`
}
