import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, userHasPermission } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { resolveOrderLines } from '@/lib/server-pricing'
import { assertOrderNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'
import { UNSET_UOM_LABEL } from '@/lib/sale-uom'
import { findInvalidLineUom } from '@/lib/sale-uom-server'

/**
 * POST /api/orders/:id/lines
 * 追加单行商品到订单，并重算订单合计。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, code: true, status: true, restaurantId: true, pricelistId: true, priceType: true },
      })
      if (!order) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      const lockedStatuses = ['LOCKED', 'CANCELLED', 'COMPLETED']
      if (lockedStatuses.includes(order.status)) {
        return NextResponse.json({ error: '该订单状态不允许修改明细' }, { status: 403 })
      }
      await assertOrderNotPickLocked(id)

      const {
        productId,
        productName,
        uomId,
        uomName,
        unitPrice,
        orderedQty,
        taxRate,
        sequence,
      } = body

      const productToAdd = await prisma.product.findUnique({
        where: { id: String(productId) },
        select: { name: true, canBeSold: true },
      })
      if (productToAdd?.canBeSold === false) {
        return NextResponse.json(
          { error: `商品「${productToAdd.name}」已下架，不可加入订单` },
          { status: 400 },
        )
      }

      // 多单位销售：追加的这行是新行，恒校验单位合法（锚点单位或已启用的
      // ProductSaleUom）——「Sellable」开关的服务端兜底，见 lib/sale-uom.ts。
      const uomError = await findInvalidLineUom([{
        productId: String(productId),
        productName: productName ? String(productName) : productToAdd?.name,
        uomId: uomId ? String(uomId) : null,
      }])
      if (uomError) return NextResponse.json({ error: uomError }, { status: 400 })

      // 服务端权威定价：追加行与下单同一套引擎，前端传的 unitPrice 只作参考，
      // 容差外一律按引擎权威价入库（见 lib/server-pricing.ts 顶部注释）。
      // 本单覆盖：沿用订单已选的 pricelistId/priceType，而非客户档案默认链
      // （否则订单编辑页里选好的 pricelist/priceType 对新追加的行不生效）。
      const { lines: resolvedLines, warnings } = await resolveOrderLines(
        { prisma, restaurantId: order.restaurantId },
        [{
          productId: String(productId),
          productName: productName ? String(productName) : undefined,
          price: unitPrice != null ? Number(unitPrice) : undefined,
          quantity: Number(orderedQty),
          uomId: uomId ? String(uomId) : undefined,
          uomName: uomName ? String(uomName) : undefined,
          taxRate: taxRate != null ? Number(taxRate) : undefined,
        }],
        {
          pricelistId: order.pricelistId, priceType: order.priceType,
          // 手动改价（台账 X1/X2）：与编辑行同一把闸，否则「改已有行能改、加新行改不了」
          allowManualPrice: userHasPermission(user, 'sales.order.override_price'),
        },
      )
      const resolved = resolvedLines[0]

      // SSOT: 追加行同样要写件提成快照,否则该行提成恒为 null。20260901 起
      // resolveOrderLines 顺带按该行选用单位折算好提成价，不用再单独查一次。
      const commissionPrice = resolved.resolvedCommissionPrice

      const newLine = await prisma.orderLine.create({
        data: {
          orderId: id,
          productId,
          productName: resolved.productName,
          uomId: uomId ?? null,
          uomName: uomName ?? UNSET_UOM_LABEL,
          unitPrice: resolved.finalUnitPrice,
          orderedQty: Number(orderedQty),
          deliveredQty: 0,
          invoicedQty: 0,
          subtotal: resolved.subtotal,
          taxRate: taxRate != null ? Number(taxRate) : null,
          sequence: sequence ?? 0,
          commissionPrice,
          // 采购成本快照(20260902)：该行选用单位下的 Product.standardPrice
          unitCost: resolved.unitCost,
          priceSourceType: resolved.manualOverride ? 'MANUAL' : resolved.resolution.sourceType.toUpperCase(),
          priceSourceDetail: resolved.manualOverride
            ? `手动改价（价格表价 €${resolved.authoritativeUnitPrice.toFixed(2)}）`
            : (resolved.resolution.sourceType === 'pricelist' ? resolved.resolution.pricelistName : null),
          priceSourceDate: resolved.lastPriceDate ?? null,
        },
      })

      const allLines = await prisma.orderLine.findMany({
        where: { orderId: id },
        select: { subtotal: true },
      })
      const newTotal = allLines.reduce((s, l) => s + Number(l.subtotal), 0)
      await prisma.order.update({
        where: { id },
        data: { totalAmount: Math.round(newTotal * 100) / 100 },
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'CREATE',
        resource: 'order',
        resourceId: id,
        // 单价记**落库值** —— 记权威价的话，手动改价后日志与订单行会各说各话
        detail: `追加订单行: ${productName}（数量 ${Number(orderedQty)}，单价 ${resolved.finalUnitPrice}`
          + `${resolved.manualOverride ? `，手动改价，价格表价 ${resolved.authoritativeUnitPrice}` : ''}）`
          + `${warnings.length ? '，警告: ' + warnings.join('; ') : ''}`,
      })

      return NextResponse.json({ ...newLine, pricingWarnings: warnings }, { status: 201 })
    } catch (e) {
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      const err = e as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? '请求无效' }, { status: err.status })
      }
      console.error('[POST order line]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '添加失败' },
        { status: 500 },
      )
    }
  }, { require: 'sales.order.update' })
}
