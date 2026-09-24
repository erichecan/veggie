import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Prisma } from '@/lib/generated/prisma/client'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { createDraftInvoiceForOrder, type InvoiceTx } from '@/lib/invoice-from-order'
import { recalcOrderCommission } from '@/lib/commission'

/** 波次完成时，处于这些在途状态的订单才推进到 COMPLETED（与 trips/[id]/route.ts 的 Trip 完成回写同一口径） */
const ORDER_COMPLETABLE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] as const

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (!wave.dispatchedAt) return NextResponse.json({ error: '该批次尚未出发' }, { status: 400 })
      if (wave.completedAt) return NextResponse.json({ error: '该批次已标记完成' }, { status: 400 })

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { completedAt: new Date() },
      })

      // 波次是现在唯一在用的调度实体（Trip 自 20260704 起已不再生成），"标记完成"
      // 之前只写了 completedAt，从未回写订单——deliveredQty 恒为 0，导致提成永远算不出来、
      // 订单永远到不了 COMPLETED、也生不出发票。这里补齐与 trips/[id]/route.ts 完全同一套
      // 回写动作：实送量默认等于下单量（方案 C，全送，可后续按退货流程覆盖）、订单推进
      // COMPLETED、幂等生成草稿发票、冻结提成快照。
      const orderIds = wave.orderIds
      if (orderIds.length > 0) {
        await prisma.$executeRaw`
          UPDATE "OrderLine" SET "deliveredQty" = "orderedQty", "updatedAt" = NOW()
          WHERE "orderId" IN (${Prisma.join(orderIds)})
        `
        await prisma.order.updateMany({
          where: { id: { in: orderIds }, status: { in: [...ORDER_COMPLETABLE_STATUSES] } },
          data: { status: 'COMPLETED' },
        })
        // createDraftInvoiceForOrder 的 InvoiceTx 是精简版结构类型，order.findUnique 那部分
        // 对不上真实 PrismaClient 的泛型重载（include/select 决定返回形状），只能在这断言，
        // 不是绕过类型检查——上面已用方法写法让其余方法免了这层断言（见该文件顶部注释）。
        for (const oid of orderIds) {
          await createDraftInvoiceForOrder(prisma as unknown as InvoiceTx, oid).catch((e: unknown) => console.error('[wave complete: auto draft invoice]', e))
        }
        for (const oid of orderIds) {
          await recalcOrderCommission(oid, prisma).catch((e: unknown) => console.error('[wave complete: commission freeze]', e))
        }
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `标记完成：批次 ${wave.name ?? id} 已完成配送，回填 ${orderIds.length} 张订单的实送数量、状态与提成`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/complete]', error)
      return NextResponse.json({ error: '标记完成失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
