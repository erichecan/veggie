import { maybeInvoiceAfterReturn, lockReturnOrders } from '@/lib/return-workflow'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { syncOrderGoodsReturnStatus } from '@/lib/returns-engine'
import { createAutoGoodsReturnPost } from '@/lib/bulletin'

/**
 * 仓库核实（退货/报废整合 M3，对齐 app/api/trips/[id]/returns/warehouse-verify 的既有规则）：
 * 日销售中心登记的退货先落 WAREHOUSE_PENDING，仓库去核对实物是否真的收到、与登记单是否一致，
 * 核实通过才转 PENDING_REVIEW 进入 operator/inventory「退换货」看板的审核栏；核实不通过直接
 * 打回（REJECTED），不做多级申诉。
 *
 * PUT /api/order-returns/:id/warehouse-verify
 * body: { action: 'verify' | 'reject', note?: string }
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { action, note, acceptedQuantity, actualReturnedProductId, actualReturnedProductName, disposition, scrapReason, actualReturnedStockQuantity } = body as { action?: 'verify' | 'reject'; note?: string; acceptedQuantity?: number; actualReturnedProductId?: string; actualReturnedProductName?: string; disposition?: 'SELLABLE' | 'SCRAP'; scrapReason?: string; actualReturnedStockQuantity?: number }

      if (action !== 'verify' && action !== 'reject') {
        return NextResponse.json({ error: '缺少必填字段: action(verify|reject)' }, { status: 400 })
      }
      if (action === 'reject' && !note?.trim()) {
        return NextResponse.json({ error: '核实不通过必须填写原因' }, { status: 400 })
      }

      const ret = await prisma.orderReturn.findUnique({
        where: { id },
        include: { order: { select: { restaurantName: true } } },
      })
      if (!ret) {
        return NextResponse.json({ error: '退货记录不存在' }, { status: 404 })
      }
      if (ret.status !== 'WAREHOUSE_PENDING') {
        return NextResponse.json(
          { error: `当前状态 ${ret.status} 不是待仓库核实，可能已被处理或数据已过期`, status: ret.status },
          { status: 409 },
        )
      }
      if (action === 'verify' && (!note?.trim() || !['SELLABLE', 'SCRAP'].includes(String(disposition)))) return NextResponse.json({ error: '核实通过须描述质量，并选择可再售或报废' }, { status: 400 })
      let confirmedQuantity: number | undefined
      let actualProduct: { id: string; name: string } | null = null
      const actualName = String(actualReturnedProductName ?? ret.actualReturnedProductName ?? '').trim()
      if (action === 'verify') {
        confirmedQuantity = acceptedQuantity == null ? toNum(ret.quantity) : Number(acceptedQuantity)
        if (!Number.isFinite(confirmedQuantity) || confirmedQuantity <= 0 || confirmedQuantity > toNum(ret.quantity) || Math.abs(confirmedQuantity * 1000 - Math.round(confirmedQuantity * 1000)) > 0.00001) {
          return NextResponse.json({ error: `仓库确认数量须大于 0 且不超过登记数量 ${ret.quantity}` }, { status: 400 })
        }
        if (actualReturnedProductId) {
          actualProduct = await prisma.product.findUnique({ where: { id: actualReturnedProductId }, select: { id: true, name: true } })
          if (!actualProduct) return NextResponse.json({ error: '实际退回商品不存在，请重新选择' }, { status: 400 })
        } else if (actualName && actualName.toLowerCase() !== ret.productName.trim().toLowerCase()) {
          return NextResponse.json({ error: '送错商品时，请选择仓库实际收到的商品' }, { status: 400 })
        }
      }

      const returnedProductId = actualProduct?.id ?? ret.actualReturnedProductId ?? ret.productId
      if (action === 'verify' && returnedProductId !== ret.productId && (!(Number(actualReturnedStockQuantity) > 0) || !Number.isFinite(Number(actualReturnedStockQuantity)))) return NextResponse.json({ error: '实际退回商品不同时，须填写实际商品的基础库存单位数量' }, { status: 400 })
      const updated = await prisma.$transaction(async (tx) => {
        await lockReturnOrders(tx, [ret.orderId])
        // updateMany + 状态锁定 where，防止两个并发核实请求都越过上面的前置检查、都执行一遍副作用
        // （原来这里连事务都没有，是本次 code-review 补的）
        const { count } = await tx.orderReturn.updateMany({
          where: { id, status: 'WAREHOUSE_PENDING' },
          data: {
            status: action === 'verify' ? 'PENDING_REVIEW' : 'REJECTED',
            warehouseVerifiedById: user.userId,
            warehouseVerifiedByName: user.name,
            warehouseVerifiedAt: new Date(),
            warehouseNote: note?.trim() || undefined,
            ...(action === 'verify' ? {
              warehouseAcceptedQuantity: confirmedQuantity,
              disposition, scrapReason: disposition === 'SCRAP' ? scrapReason || 'CUSTOMER_RETURN_DAMAGED' : null,
              actualReturnedStockQuantity: returnedProductId !== ret.productId ? Number(actualReturnedStockQuantity) : null,
              actualReturnedProductId: actualProduct?.id ?? ret.actualReturnedProductId,
              actualReturnedProductName: actualProduct?.name ?? (actualName || ret.productName),
            } : {}),
          },
        })
        if (count === 0) return null

        // 核实不通过是终态（REJECTED），跟 review 路由拒绝分支一样要回写 Order 角标；
        // 原来这里漏了，角标会一直停在"无退货"，看不出这单曾经报过退货又被仓库打回
        if (action === 'reject') {
          await syncOrderGoodsReturnStatus(tx, [{
            orderId: ret.orderId,
            status: 'REJECTED',
            productName: ret.productName,
            quantity: confirmedQuantity ?? toNum(ret.quantity),
          }], user)
        } else {
          await createAutoGoodsReturnPost(tx, {
            restaurantName: ret.order.restaurantName,
            productName: actualProduct?.name ?? (actualName || ret.productName),
            quantity: confirmedQuantity ?? toNum(ret.quantity),
            linkUrl: `/classic/operator/inventory?tab=returns&highlight=${ret.id}&source=order_return`,
          })
        }

        if (action === 'reject') await maybeInvoiceAfterReturn(tx, ret.orderId)
        return tx.orderReturn.findUnique({ where: { id } })
      }, { timeout: 60000, maxWait: 10000 })

      if (!updated) {
        return NextResponse.json(
          { error: '该退货记录已被处理，请刷新后重试', status: 'RACED' },
          { status: 409 },
        )
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order_return', resourceId: id,
        detail: `仓库核实退货: ${actualProduct?.name ?? (actualName || ret.productName)} × ${confirmedQuantity ?? ret.quantity} — ${action === 'verify' ? '核实通过' : `核实不通过(${note})`}`,
      })

      return NextResponse.json(serializeApi({
        message: action === 'verify' ? '已核实通过，转入审核' : '已标记核实不通过，退货申请已打回',
        orderReturn: updated,
      }))
    } catch (error) {
      console.error('[PUT /api/order-returns/[id]/warehouse-verify]', error)
      return NextResponse.json({ error: '仓库核实失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.warehouse_verify' })
}
