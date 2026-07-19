import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { notifyLowStockAfterConfirm } from '@/lib/notify'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { deriveOrderItems, buildOrderItemsSnapshot } from '@/lib/order-items'
import { consumeLotsFIFO, restoreLotsFIFO, toStockQty } from '@/lib/inventory'
import { assignOrderToWave, removeOrderFromAllWaves, getOrderWaveDisplayMap, getOrderWaveDriverSlotMap } from '@/lib/wave-assign'
import { createDraftInvoiceForOrder } from '@/lib/invoice-from-order'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { recalcOrderCommission, recalcTripDriverCommission } from '@/lib/commission'
import { assertOrderNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'

const ORDER_TRACKED_FIELDS = [
  'status', 'paymentMethod', 'totalAmount',
  'confirmationDate', 'deliveryDate', 'invoiceDate', 'quotationDate',
  'internalNote', 'externalNote', 'deliveryNote', 'pricelistId', 'priceType', 'restaurantName',
  'driverSlotId', 'deliveryBatch',
]

const VALID_PRICE_TYPES = new Set(['multi', 'default', 'last'])

// ── 状态流转白名单 ─────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  PENDING: new Set(['CONFIRMED', 'CANCELLED']),
  CONFIRMED: new Set(['PENDING', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'CANCELLED']),
  WAVE_ASSIGNED: new Set(['CONFIRMED', 'IN_DELIVERY', 'CANCELLED']),
  IN_DELIVERY: new Set(['COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(['LOCKED']),
  LOCKED: new Set(),      // 不可变
  CANCELLED: new Set(),   // 不可变
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { sequence: 'asc' },
          include: { product: { select: { standardPrice: true, internalRef: true } } },
        },
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
        salesUser: { select: { id: true, name: true } },
      },
    })
    if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    // Flatten product fields onto each line so UI can read l.cost
    const waveDisplay = await getOrderWaveDisplayMap([order.id])
    // 编辑态司机下拉框预选值:与显示态同源(所属 wave),订单不在任何 wave 时回退下单意向列
    const waveDriverSlot = await getOrderWaveDriverSlotMap([order.id])
    // 下单/报价/销售单详情页不展示提成字段(PRD 20260703 Stage 8)：整单剔除 commission* 快照
    const { commissionRate: _commissionRate, commissionFixed: _commissionFixed,
      driverCommissionTotal: _driverCommissionTotal, commissionFrozenAt: _commissionFrozenAt,
      ...orderWithoutCommission } = order
    const enrichedOrder = {
      ...orderWithoutCommission,
      // 只读展示兼容层：salesUser 关联展平成 salesman 字符串,方便旧的只读页面继续显示业务员姓名
      salesman: order.salesUser?.name ?? null,
      // SSOT(P0-1): 调度归属显示由所属 wave 派生
      deliveryBatchDisplay: waveDisplay[order.id] ?? null,
      // 编辑态下拉框预选:所属 wave 的 driverSlotId(真相),回退到下单意向列
      currentDriverSlotId: waveDriverSlot[order.id] ?? order.driverSlotId ?? null,
      lines: order.lines.map(({ product, commissionPrice: _commissionPrice, ...line }) => ({
        ...line,
        cost: toNum(product?.standardPrice),
        internalRef: product?.internalRef ?? null,
      })),
    }
    return NextResponse.json(deriveOrderItems(serializeApi(enrichedOrder)))
  } catch (error) {
    console.error('[GET /api/orders/[id]]', error)
    return NextResponse.json({ error: '获取订单失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const orderBefore = await prisma.order.findUnique({ where: { id } })
      if (!orderBefore) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      // Strip non-schema fields before passing to Prisma
      const { confirmationDate, deliveryDate, invoiceDate, quotationDate, internalNote, externalNote, deliveryNote, status, paymentMethod, salesUserId, deliveryBatch, driverSlotId, pricelistId, priceType, lines: linesPayload, totalAmount: totalAmountPayload } = data

      // Determine new status
      const newStatus = status ? String(status).toUpperCase() : undefined

      // 库存批次日期：优先用交付日期，无则用当前时间
      const orderMovedAt: Date = deliveryDate ? new Date(deliveryDate)
        : orderBefore.deliveryDate ? new Date(orderBefore.deliveryDate as unknown as string)
        : new Date()

      // ── 状态流转守卫 ──────────────────────────────────────────────────────
      if (newStatus && newStatus !== String(orderBefore.status)) {
        const currentStatus = String(orderBefore.status).toUpperCase()
        const allowed = ALLOWED_TRANSITIONS[currentStatus]
        if (!allowed || !allowed.has(newStatus)) {
          return NextResponse.json(
            { error: `不允许从 ${currentStatus} 转为 ${newStatus}` },
            { status: 409 },
          )
        }
      }

      // ── LOCKED / CANCELLED 订单禁止任何修改 ────────────────────────────────
      const immutableStatuses = new Set(['LOCKED', 'CANCELLED'])
      if (immutableStatuses.has(String(orderBefore.status).toUpperCase()) && !newStatus) {
        return NextResponse.json(
          { error: `${orderBefore.status} 状态的订单不可修改` },
          { status: 409 },
        )
      }

      // ── 已出发及以后(IN_DELIVERY/COMPLETED/LOCKED/CANCELLED)订单禁止改派司机 ──
      // 调度归属真相在 wave,这些订单的 wave 已锁定/出发。若放行:order.driverSlotId 写脏值,
      // 而 wave 同步(assignOrderToWave)被 pick-lock 挡回并静默吞掉,造成显示/编辑分叉且误报"已保存"。
      // 要改派须走调度台重排。比较基准取 wave 派生真值(非 order.driverSlotId,后者可能是历史脏值)。
      const driverLockedStatuses = new Set(['IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED'])
      if (driverSlotId !== undefined && driverLockedStatuses.has(String(orderBefore.status).toUpperCase())) {
        const waveSlot = (await getOrderWaveDriverSlotMap([id]))[id] ?? orderBefore.driverSlotId ?? null
        if ((driverSlotId || null) !== waveSlot) {
          return NextResponse.json(
            { error: `${orderBefore.status} 状态的订单不可改派司机，请到调度台调整` },
            { status: 409 },
          )
        }
      }

      // ── WAVE_ASSIGNED 及以后禁止直接改交货日期 ──
      // 分配进波次时会强制把 deliveryDate 回写成 wave.waveDate(见 waves/[id]/assign)，
      // 这里放行会让两者分裂——订单还挂在原波次里，deliveryDate 却指向别的日期，
      // 调度台按 deliveryDate 筛的候选订单/待分配查询就再也找不到它(表现为"编辑成功但订单消失")。
      // 要改期须先到调度台把订单拖回待分配(状态退回 CONFIRMED)才能自由改。
      const dateLockedStatuses = new Set(['WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED'])
      if (deliveryDate !== undefined && dateLockedStatuses.has(String(orderBefore.status).toUpperCase())) {
        const oldDd = orderBefore.deliveryDate ? new Date(orderBefore.deliveryDate as unknown as string).toISOString().slice(0, 10) : null
        const newDd = deliveryDate ? new Date(deliveryDate).toISOString().slice(0, 10) : null
        if (oldDd !== newDd) {
          return NextResponse.json(
            { error: `${orderBefore.status} 状态的订单交货日期已绑定所在波次，不可直接修改，请到调度台移出待分配后再调整` },
            { status: 409 },
          )
        }
      }

      // ── 拣货锁：订单在已锁定波次里时，禁止改内容(明细/合计)。锁定=拣货作业进行中，
      // 不许再动这张单。仅拦内容编辑，不拦纯状态流转(确认出发/完成/撤回走其它路径需放行)。
      if (Array.isArray(linesPayload) || totalAmountPayload !== undefined) {
        await assertOrderNotPickLocked(id)
      }

      // ── P0-1: CONFIRMED/WAVE_ASSIGNED 状态下编辑行需要计算库存差额（已扣过库存）──
      const currentStatus = String(orderBefore.status).toUpperCase()
      const postConfirmStatuses = new Set(['CONFIRMED', 'WAVE_ASSIGNED'])
      const needStockDelta = postConfirmStatuses.has(currentStatus) && !newStatus && Array.isArray(data.lines)

      // Build update payload — only include defined values (never spread unknown fields)
      const updateData: Record<string, unknown> = {}
      if (newStatus) updateData.status = newStatus
      if (salesUserId !== undefined) updateData.salesUserId = salesUserId ? String(salesUserId) : null
      // SSOT(P0-1): deliveryBatch 字符串弃用,不再写入;调度归属真相在 wave。
      // driverSlotId 保留为「下单意向」列,实际 wave 归属在 update 之后经 wave-assign 同步(双向一致)。
      if (driverSlotId !== undefined) updateData.driverSlotId = driverSlotId || null
      if (paymentMethod) updateData.paymentMethod = String(paymentMethod).toUpperCase()
      if (confirmationDate !== undefined) updateData.confirmationDate = confirmationDate ? new Date(confirmationDate) : null
      if (deliveryDate !== undefined) updateData.deliveryDate = deliveryDate ? new Date(deliveryDate) : null
      if (invoiceDate !== undefined) updateData.invoiceDate = invoiceDate ? new Date(invoiceDate) : null
      if (quotationDate !== undefined) updateData.quotationDate = quotationDate ? new Date(quotationDate) : null
      if (internalNote !== undefined) updateData.internalNote = internalNote ? String(internalNote) : null
      if (externalNote !== undefined) updateData.externalNote = externalNote ? String(externalNote) : null
      if (deliveryNote !== undefined) updateData.deliveryNote = deliveryNote ? String(deliveryNote) : null
      if (pricelistId !== undefined) updateData.pricelistId = pricelistId ? String(pricelistId) : null
      if (priceType !== undefined) {
        const pt = String(priceType).toLowerCase()
        if (!VALID_PRICE_TYPES.has(pt)) {
          return NextResponse.json({ error: `priceType 无效：${priceType}` }, { status: 400 })
        }
        updateData.priceType = pt
      }

      // Auto-set confirmationDate when confirming
      if (newStatus === 'CONFIRMED' && !confirmationDate) {
        updateData.confirmationDate = new Date()
      }
      // Clear confirmationDate when withdrawing back to PENDING
      if (newStatus === 'PENDING' && confirmationDate === null) {
        updateData.confirmationDate = null
      }

      // Load current lines (needed for both line operations and audit diff)
      const currentLines = Array.isArray(linesPayload)
        ? await prisma.orderLine.findMany({
            where: { orderId: id },
            include: { product: { include: { template: { select: { type: true } } } } },
          })
        : []
      let toDelete: string[] = []

      // If lines are provided, replace all: update existing, create new, delete removed
      if (Array.isArray(linesPayload)) {
        // ── IN_DELIVERY 状态修改行时，需要计算库存差额 ──────────────────────────
        const isInDelivery = String(orderBefore.status).toUpperCase() === 'IN_DELIVERY'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const prismaAnyLines = prisma as any

        const currentLineMap = new Map(currentLines.map(l => [l.id, l]))

        // 多单位销售(20260714)：编辑已有行允许切换该行的销售单位。校验新单位必须是该商品的
        // 锚点单位(ProductTemplate.uomId)或已配置的 active ProductSaleUom，防止乱传/脏数据。
        const uomEditCandidates = (linesPayload as Record<string, unknown>[]).filter(l => l.id && l.uomId !== undefined)
        if (uomEditCandidates.length > 0) {
          const affectedProductIds = Array.from(new Set(
            uomEditCandidates
              .map(l => currentLineMap.get(String(l.id))?.productId)
              .filter((v): v is string => !!v)
          ))
          const productsForUomCheck = affectedProductIds.length > 0
            ? await prisma.product.findMany({
                where: { id: { in: affectedProductIds } },
                select: {
                  id: true,
                  template: { select: { uomId: true } },
                  saleUoms: { where: { active: true }, select: { uomId: true } },
                },
              })
            : []
          const allowedUomMap = new Map(
            productsForUomCheck.map(p => [
              p.id,
              new Set([p.template?.uomId, ...p.saleUoms.map(s => s.uomId)].filter((v): v is string => !!v)),
            ])
          )
          for (const l of uomEditCandidates) {
            const oldLine = currentLineMap.get(String(l.id))
            if (!oldLine) continue
            const newUomId = l.uomId ? String(l.uomId) : null
            if (newUomId === (oldLine.uomId ?? null)) continue // 未变化
            if (!newUomId || !allowedUomMap.get(oldLine.productId)?.has(newUomId)) {
              return NextResponse.json({ error: `商品「${oldLine.productName}」不支持切换到该单位` }, { status: 400 })
            }
          }
        }

        const existingIds = new Set(currentLines.map(l => l.id))
        const payloadIds = new Set(
          (linesPayload as Record<string, unknown>[]).filter(l => l.id).map(l => String(l.id))
        )
        toDelete = [...existingIds].filter(dbId => !payloadIds.has(dbId))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txOps: any[] = []

        if (toDelete.length > 0) {
          txOps.push(prisma.orderLine.deleteMany({ where: { id: { in: toDelete } } }))
        }

        // SSOT: 新增行同样要写件提成快照,否则该行提成恒为 null
        const newLineProductIds = (linesPayload as Record<string, unknown>[])
          .filter(l => !l.id)
          .map(l => String(l.productId ?? ''))
          .filter(Boolean)
        const newLineProducts = newLineProductIds.length > 0
          ? await prisma.product.findMany({
              where: { id: { in: newLineProductIds } },
              include: { template: { select: { commissionPrice: true, canBeSold: true } } },
            })
          : []

        // 准入闸门：只查新增行，已有行（哪怕它引用的商品后来被关闭 canBeSold）永远不受影响
        const notSellable = newLineProducts.filter(p => p.template?.canBeSold === false)
        if (notSellable.length > 0) {
          return NextResponse.json(
            { error: `商品「${notSellable.map(p => p.name).join('、')}」已下架，不可加入订单` },
            { status: 400 },
          )
        }

        const newLineCommissionMap = new Map(
          newLineProducts.map(p => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
        )

        for (const l of linesPayload as Record<string, unknown>[]) {
          // SSOT: subtotal 服务端按 unitPrice×orderedQty 重算,不信前端传值(防金额被篡改/算错)
          const lineData: Record<string, unknown> = {
            orderedQty: Number(l.orderedQty),
            unitPrice: Number(l.unitPrice),
            subtotal: Math.round(Number(l.orderedQty) * Number(l.unitPrice) * 100) / 100,
          }
          if (l.taxRate !== undefined) lineData.taxRate = Number(l.taxRate)
          if (l.sequence !== undefined) lineData.sequence = Number(l.sequence)
          if (l.spec !== undefined) lineData.spec = l.spec ? String(l.spec) : null
          if (l.note !== undefined) lineData.note = l.note ? String(l.note) : null
          // 单价来源快照：编辑态由客户端算好传上来(见 orders/[id]/page.tsx updateLine)，
          // 手动改价时客户端会把这三个字段清空，这里原样落库，不重新推断。
          if (l.priceSourceType !== undefined) lineData.priceSourceType = l.priceSourceType ? String(l.priceSourceType) : null
          if (l.priceSourceDetail !== undefined) lineData.priceSourceDetail = l.priceSourceDetail ? String(l.priceSourceDetail) : null
          if (l.priceSourceDate !== undefined) lineData.priceSourceDate = l.priceSourceDate ? new Date(String(l.priceSourceDate)) : null
          // 多单位销售(20260714)：编辑已有行时也允许写入新单位(此前只有新增行分支才写 uomId/uomName，
          // 已有行传了新单位会被静默忽略)。合法性已在上面 uomEditCandidates 校验过。
          if (l.uomId !== undefined) {
            lineData.uomId = l.uomId ? String(l.uomId) : null
            lineData.uomName = l.uomName ? String(l.uomName) : null
          }

          if (l.id) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
            txOps.push((prisma.orderLine.update as Function)({
              where: { id: String(l.id) },
              data: lineData,
            }))
          } else {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
            txOps.push((prisma.orderLine.create as Function)({
              data: {
                ...lineData,
                orderId: id,
                productId: String(l.productId ?? ''),
                productName: String(l.productName ?? ''),
                spec: l.spec ? String(l.spec) : null,
                note: l.note ? String(l.note) : null,
                uomId: l.uomId ? String(l.uomId) : null,
                uomName: l.uomName ? String(l.uomName) : null,
                deliveredQty: 0,
                invoicedQty: 0,
                sequence: Number(l.sequence ?? 0),
                commissionPrice: newLineCommissionMap.get(String(l.productId ?? '')) ?? null,
              },
            }))
          }
        }

        if (txOps.length > 0) {
          await prisma.$transaction(txOps)
        }

        // ── P0-1 + IN_DELIVERY 库存差额调整 ──────────────────────────────────
        // CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY 状态下编辑行，均需计算库存差额
        if (isInDelivery || needStockDelta) {
          const statusLabel = isInDelivery ? '配货中' : '确认后'
          // 被删除的行：释放全部库存
          for (const deletedId of toDelete) {
            const oldLine = currentLineMap.get(deletedId)
            if (!oldLine || !oldLine.product || oldLine.product.template?.type !== 'PRODUCT') continue
            const releaseQty = toNum(oldLine.orderedQty)
            if (releaseQty <= 0) continue
            const stockReleaseQty = await toStockQty(prismaAnyLines, oldLine.productId, releaseQty, oldLine.uomId)
            await prismaAnyLines.product.update({
              where: { id: oldLine.productId },
              data: { qtyOnHand: { increment: stockReleaseQty } },
            })
            await prismaAnyLines.stockMove.create({
              data: {
                productId: oldLine.productId,
                productName: oldLine.productName ?? '',
                type: 'IN',
                qty: stockReleaseQty,
                movedAt: orderMovedAt,
                note: `订单 ${orderBefore.code ?? id} ${statusLabel}删除行释放`,
                sourceType: 'ORDER',
                sourceId: id,
                sourceRef: orderBefore.code ?? id,
              },
            })
          }

          // 数量变更的行：计算差额
          for (const l of linesPayload as Record<string, unknown>[]) {
            if (!l.id) {
              // 新增行：额外扣减库存
              const productId = String(l.productId ?? '')
              const qty = Number(l.orderedQty)
              if (!productId || qty <= 0) continue
              const prod = await prismaAnyLines.product.findUnique({
                where: { id: productId },
                include: { template: { select: { type: true } } },
              })
              if (!prod || prod.template?.type !== 'PRODUCT') continue
              const stockQty = await toStockQty(prismaAnyLines, productId, qty, l.uomId ? String(l.uomId) : undefined)
              await prismaAnyLines.product.update({
                where: { id: productId },
                data: { qtyOnHand: { decrement: stockQty } },
              })
              await prismaAnyLines.stockMove.create({
                data: {
                  productId,
                  productName: String(l.productName ?? ''),
                  type: 'OUT',
                  qty: -stockQty,
                  movedAt: orderMovedAt,
                  note: `订单 ${orderBefore.code ?? id} ${statusLabel}新增行扣减`,
                  sourceType: 'ORDER',
                  sourceId: id,
                  sourceRef: orderBefore.code ?? id,
                },
              })
            } else {
              // 已有行：检查数量/单位变化(多单位销售 20260714 起，切单位也需要联动库存)
              const oldLine = currentLineMap.get(String(l.id))
              if (!oldLine || !oldLine.product || oldLine.product.template?.type !== 'PRODUCT') continue
              const oldQty = toNum(oldLine.orderedQty)
              const newQty = Number(l.orderedQty)
              const newUomId = l.uomId !== undefined ? (l.uomId ? String(l.uomId) : null) : oldLine.uomId
              if (newQty === oldQty && newUomId === oldLine.uomId) continue
              // 数量和单位可能同时变化，各自按自己的单位换算成库存记账单位后再相减，
              // 不能再用"newQty-oldQty"直接相减(两个数字含义的单位可能不同)
              const oldStockQty = await toStockQty(prismaAnyLines, oldLine.productId, oldQty, oldLine.uomId)
              const newStockQty = await toStockQty(prismaAnyLines, oldLine.productId, newQty, newUomId)
              const stockDelta = newStockQty - oldStockQty
              if (stockDelta === 0) continue
              const oldLabel = `${oldQty}${oldLine.uomName ?? ''}`
              const newLabel = `${newQty}${(l.uomName ? String(l.uomName) : oldLine.uomName) ?? ''}`

              if (stockDelta > 0) {
                // 净消耗增加 → 额外扣减
                await prismaAnyLines.product.update({
                  where: { id: oldLine.productId },
                  data: { qtyOnHand: { decrement: stockDelta } },
                })
                await prismaAnyLines.stockMove.create({
                  data: {
                    productId: oldLine.productId,
                    productName: oldLine.productName ?? '',
                    type: 'OUT',
                    qty: -stockDelta,
                    movedAt: orderMovedAt,
                    note: `订单 ${orderBefore.code ?? id} ${statusLabel}增量 ${oldLabel}→${newLabel}`,
                    sourceType: 'ORDER',
                    sourceId: id,
                    sourceRef: orderBefore.code ?? id,
                  },
                })
              } else {
                // 净消耗减少 → 释放差额
                const release = Math.abs(stockDelta)
                await prismaAnyLines.product.update({
                  where: { id: oldLine.productId },
                  data: { qtyOnHand: { increment: release } },
                })
                await prismaAnyLines.stockMove.create({
                  data: {
                    productId: oldLine.productId,
                    productName: oldLine.productName ?? '',
                    type: 'IN',
                    qty: release,
                    movedAt: orderMovedAt,
                    note: `订单 ${orderBefore.code ?? id} ${statusLabel}减量 ${oldLabel}→${newLabel}`,
                    sourceType: 'ORDER',
                    sourceId: id,
                    sourceRef: orderBefore.code ?? id,
                  },
                })
              }
            }
          }
        }

        // SSOT: totalAmount 服务端重算 = Σ税前(line.subtotal=unitPrice×qty 税前,
        // totalAmount 亦为税前,与下单 server-pricing.ts / 加行 lines/route.ts 口径一致)。不信前端传值。
        const computedTotal = (linesPayload as Record<string, unknown>[]).reduce((s, l) => {
          const exTax = Math.round(Number(l.orderedQty) * Number(l.unitPrice) * 100) / 100
          return s + exTax
        }, 0)
        updateData.totalAmount = Math.round(computedTotal * 100) / 100
        // 改动 OrderLine 后同步 items 快照(随本次 order.update 一并写),
        // 下游直接读 items 列的端点(波次/配送/司机汇总/核货)拿到新数量
        updateData.items = (await buildOrderItemsSnapshot(prisma, id)) as unknown as object
      } else if (totalAmountPayload !== undefined) {
        // 未改行只改总额:也不信前端,从当前 OrderLine 税前重算
        const dbLines = await prisma.orderLine.findMany({ where: { orderId: id }, select: { orderedQty: true, unitPrice: true } })
        const recomputed = dbLines.reduce((s, l) => {
          const exTax = Math.round(toNum(l.orderedQty) * toNum(l.unitPrice) * 100) / 100
          return s + exTax
        }, 0)
        updateData.totalAmount = Math.round(recomputed * 100) / 100
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      const order = await (prisma.order.update as Function)({
        where: { id },
        data: updateData,
        include: {
          lines: { orderBy: { sequence: 'asc' } },
          driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
        },
      })

      // SSOT(P0-1): 销售单改批次同步到 wave.orderIds(与调度台拖拽同一写入逻辑,双向一致)
      // wave 同步失败(如目标波次已锁定/出发)不再静默吞掉:回滚刚写入的 order.driverSlotId
      // 避免与 wave 分叉,并让保存整体失败(前端收到 409,不再误报"已保存")。
      if (driverSlotId !== undefined) {
        try {
          if (driverSlotId) await assignOrderToWave(id, String(driverSlotId))
          else await removeOrderFromAllWaves(id)
        } catch (e) {
          console.error('[wave sync failed → rollback driverSlotId]', e)
          await prisma.order.update({ where: { id }, data: { driverSlotId: orderBefore.driverSlotId } }).catch(() => {})
          return NextResponse.json(
            { error: '司机分配失败：目标波次可能已锁定或出发，请到调度台调整' },
            { status: 409 },
          )
        }
      }

      // 撤回报价单(PENDING)/取消(CANCELLED):订单退出配送流程,同步移出所属波次,
      // 否则调度台/打印中心会残留"幽灵单"(报价单却出现在波次里,数量对不上销售单列表)。
      if (newStatus === 'PENDING' || newStatus === 'CANCELLED') {
        await removeOrderFromAllWaves(id).catch((e) => console.error('[removeOrderFromAllWaves on status change]', e))
      }

      // Determine audit action
      let auditAction = 'updated'
      if (newStatus === 'CONFIRMED') auditAction = 'confirmed'
      else if (newStatus === 'PENDING' && String(orderBefore.status) === 'CONFIRMED') auditAction = 'withdrawn'
      else if (newStatus === 'COMPLETED') auditAction = 'completed'
      else if (newStatus === 'CANCELLED') auditAction = 'cancelled'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prismaAny = prisma as any

      // ── Build detailed changedFields for audit log ──────────────────────────
      const auditChangedFields: Record<string, unknown> = {}

      // Status transition
      if (newStatus && newStatus !== String(orderBefore.status)) {
        auditChangedFields.status = { before: orderBefore.status, after: newStatus }
      }

      // Scalar field changes
      if (paymentMethod && String(paymentMethod).toUpperCase() !== String(orderBefore.paymentMethod)) {
        auditChangedFields.paymentMethod = { before: orderBefore.paymentMethod, after: String(paymentMethod).toUpperCase() }
      }
      if (salesUserId !== undefined && salesUserId !== (orderBefore as unknown as Record<string, unknown>).salesUserId) {
        auditChangedFields.salesUserId = { before: (orderBefore as unknown as Record<string, unknown>).salesUserId ?? null, after: salesUserId || null }
      }
      if (deliveryDate !== undefined) {
        const oldDd = orderBefore.deliveryDate ? new Date(orderBefore.deliveryDate).toISOString().slice(0, 10) : null
        const newDd = deliveryDate ? new Date(deliveryDate).toISOString().slice(0, 10) : null
        if (oldDd !== newDd) auditChangedFields.deliveryDate = { before: oldDd, after: newDd }
      }
      if (internalNote !== undefined && internalNote !== (orderBefore as unknown as Record<string, unknown>).internalNote) {
        auditChangedFields.internalNote = { before: (orderBefore as unknown as Record<string, unknown>).internalNote ?? null, after: internalNote || null }
      }
      if (externalNote !== undefined && externalNote !== (orderBefore as unknown as Record<string, unknown>).externalNote) {
        auditChangedFields.externalNote = { before: (orderBefore as unknown as Record<string, unknown>).externalNote ?? null, after: externalNote || null }
      }

      // Line-level changes: added, deleted, modified
      if (Array.isArray(linesPayload)) {
        const lineChanges: {
          added: { productName: string; qty: number; unitPrice: number }[]
          deleted: { productName: string; qty: number; unitPrice: number }[]
          modified: { productName: string; qtyBefore: number; qtyAfter: number; priceBefore: number; priceAfter: number }[]
        } = { added: [], deleted: [], modified: [] }

        const currentLineMap2 = new Map(currentLines.map(l => [l.id, l]))

        // Deleted lines
        for (const deletedId of toDelete) {
          const oldLine = currentLineMap2.get(deletedId)
          if (oldLine) {
            lineChanges.deleted.push({
              productName: oldLine.productName ?? '',
              qty: toNum(oldLine.orderedQty),
              unitPrice: toNum(oldLine.unitPrice),
            })
          }
        }

        // Added and modified lines
        for (const l of linesPayload as Record<string, unknown>[]) {
          if (!l.id) {
            // New line
            lineChanges.added.push({
              productName: String(l.productName ?? ''),
              qty: Number(l.orderedQty),
              unitPrice: Number(l.unitPrice),
            })
          } else {
            // Existing line — check for qty/price changes
            const oldLine = currentLineMap2.get(String(l.id))
            if (oldLine) {
              const oldQty = toNum(oldLine.orderedQty)
              const newQty = Number(l.orderedQty)
              const oldPrice = toNum(oldLine.unitPrice)
              const newPrice = Number(l.unitPrice)
              if (oldQty !== newQty || Math.abs(oldPrice - newPrice) > 0.001) {
                lineChanges.modified.push({
                  productName: oldLine.productName ?? '',
                  qtyBefore: oldQty,
                  qtyAfter: newQty,
                  priceBefore: oldPrice,
                  priceAfter: newPrice,
                })
              }
            }
          }
        }

        if (lineChanges.added.length > 0 || lineChanges.deleted.length > 0 || lineChanges.modified.length > 0) {
          auditChangedFields.lineChanges = lineChanges
        }
      }

      // Write audit log
      await prismaAny.orderAuditLog.create({
        data: {
          orderId: id,
          userId: user.userId,
          action: auditAction,
          totalBefore: toNum(orderBefore.totalAmount),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          totalAfter: toNum((order as any).totalAmount),
          changedFields: Object.keys(auditChangedFields).length > 0 ? auditChangedFields : undefined,
        },
      })

      // On CONFIRMED: 库存预留（扣减 qtyOnHand 作为预留代理；允许负库存，不阻断确认）
      if (newStatus === 'CONFIRMED' && String(orderBefore.status) === 'PENDING') {
        const confirmLines = await prisma.orderLine.findMany({
          where: { orderId: id },
          include: { product: { include: { template: { select: { type: true } } } } },
        })

        for (const line of confirmLines) {
          if (!line.product || line.product.template?.type !== 'PRODUCT') continue
          const qty = toNum(line.orderedQty)
          if (qty <= 0) continue
          // 多单位销售：这行如果用的不是商品当前默认单位，换算成库存记账单位数量再扣
          const stockQty = await toStockQty(prismaAny, line.productId, qty, line.uomId)

          const onHand = toNum(line.product.qtyOnHand)
          if (onHand < stockQty) {
            console.warn(`[order confirm] 库存不足（允许继续）: ${line.productName} 现有 ${onHand}，需要 ${stockQty}`)
          }

          await prismaAny.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { decrement: stockQty } },
          })
          // SSOT: 同步 FIFO 扣减批次余量,避免 Lot 虚高(P1-5)
          const consumed = await consumeLotsFIFO(prismaAny, line.productId, stockQty)
          // 按实际消耗的批次拆分 StockMove,lotId 落到批次级别 —— 批次追溯"这批卖给了谁"的数据基础
          const consumedQty = consumed.reduce((s, c) => s + c.qty, 0)
          const unmatched = round2(stockQty - consumedQty)
          const moveRows = consumed.map(c => ({
            productId: line.productId,
            productName: line.productName ?? '',
            type: 'OUT' as const,
            qty: -c.qty,
            lotId: c.lotId,
            movedAt: orderMovedAt,
            note: `订单 ${orderBefore.code ?? id} 确认预留（批次 ${c.lotNumber}）`,
            sourceType: 'ORDER',
            sourceId: id,
            sourceRef: orderBefore.code ?? id,
          }))
          if (unmatched > 0) {
            // 超卖部分无批次可扣，仍需一条不带 lotId 的move保证 qtyOnHand 有完整流水
            moveRows.push({
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'OUT' as const,
              qty: -unmatched,
              lotId: undefined as unknown as string,
              movedAt: orderMovedAt,
              note: `订单 ${orderBefore.code ?? id} 确认预留（超卖，无批次）`,
              sourceType: 'ORDER',
              sourceId: id,
              sourceRef: orderBefore.code ?? id,
            })
          }
          for (const row of moveRows) {
            await prismaAny.stockMove.create({ data: row })
          }
        }
      }

      // On CONFIRMED: 仅建送货单。Trip 不再在确认时建(P0-2/A):配送调度统一归 wave,
      // Trip 改在 wave「确认出发」时按波次生成(见 waves/[id]/dispatch + lib/trip-from-wave)。
      if (newStatus === 'CONFIRMED') {
        const existingSlip = await prismaAny.deliverySlip.findUnique({ where: { orderId: id } }).catch(() => null)
        if (!existingSlip) {
          await prismaAny.deliverySlip.create({
            data: {
              orderId: id,
              customerId: orderBefore.restaurantId,
              customerName: orderBefore.restaurantName,
              deliveryDate: updateData.deliveryDate as Date | null ?? null,
            },
          }).catch((e: unknown) => console.error('[DeliverySlip create]', e))
        }
      }

      // On COMPLETED: 自动生成 DRAFT 发票(幂等),保证每张完成单都有发票供应收口径用(finance)
      if (newStatus === 'COMPLETED') {
        await createDraftInvoiceForOrder(prismaAny, id).catch((e: unknown) => console.error('[auto draft invoice]', e))
        // 送达冻结司机提成快照（个单完成路径，非经 Trip 批量完成）
        await recalcOrderCommission(id, prisma).catch((e: unknown) => console.error('[commission freeze]', e))
        const ownerTrip = await prismaAny.trip.findFirst({
          where: { restaurants: { path: '$[*].orderIds[*]', array_contains: id } },
          select: { id: true },
        }).catch(() => null)
        if (ownerTrip) {
          await recalcTripDriverCommission(ownerTrip.id, prisma).catch((e: unknown) => console.error('[trip commission sync]', e))
        }
      }

      // On WITHDRAWN (CONFIRMED → PENDING): 恢复库存预留
      if (newStatus === 'PENDING' && String(orderBefore.status) === 'CONFIRMED') {
        const withdrawLines = await prisma.orderLine.findMany({
          where: { orderId: id },
          include: { product: { include: { template: { select: { type: true } } } } },
        })

        for (const line of withdrawLines) {
          if (!line.product || line.product.template?.type !== 'PRODUCT') continue
          const qty = toNum(line.orderedQty)
          if (qty <= 0) continue
          const stockQty = await toStockQty(prismaAny, line.productId, qty, line.uomId)

          await prismaAny.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: stockQty } },
          })
          // SSOT: 撤回时回补批次余量(P1-5)
          await restoreLotsFIFO(prismaAny, line.productId, stockQty)
          await prismaAny.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'IN',
              qty: stockQty,
              movedAt: orderMovedAt,
              note: `订单 ${orderBefore.code ?? id} 撤回释放预留`,
              sourceType: 'ORDER',
              sourceId: id,
              sourceRef: orderBefore.code ?? id,
            },
          })
        }
      }

      // On WITHDRAWN (CONFIRMED → PENDING): cancel associated PENDING_ASSIGNMENT trips
      if (newStatus === 'PENDING' && String(orderBefore.status) === 'CONFIRMED') {
        await prismaAny.trip.updateMany({
          where: {
            status: 'PENDING_ASSIGNMENT',
            restaurants: { path: '$[*].orderIds[*]', array_contains: id },
          },
          data: { status: 'PENDING' },
        }).catch((e: unknown) => console.error('[Trip cancel on withdraw]', e))
      }

      // ── On CANCELLED: 恢复库存 + 取消关联 Trip ─────────────────────────────
      if (newStatus === 'CANCELLED') {
        const prevStatus = String(orderBefore.status).toUpperCase()
        // 只有 CONFIRMED / WAVE_ASSIGNED / IN_DELIVERY 已经扣过库存，需要恢复
        const stockReservedStatuses = new Set(['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
        if (stockReservedStatuses.has(prevStatus)) {
          // 使用当前 orderLines（已经是最新的，可能被本次 PUT 修改过）恢复库存
          const cancelLines = await prisma.orderLine.findMany({
            where: { orderId: id },
            include: { product: { include: { template: { select: { type: true } } } } },
          })
          for (const line of cancelLines) {
            if (!line.product || line.product.template?.type !== 'PRODUCT') continue
            const qty = toNum(line.orderedQty)
            if (qty <= 0) continue
            const stockQty = await toStockQty(prismaAny, line.productId, qty, line.uomId)
            await prismaAny.product.update({
              where: { id: line.productId },
              data: { qtyOnHand: { increment: stockQty } },
            })
            await prismaAny.stockMove.create({
              data: {
                productId: line.productId,
                productName: line.productName ?? '',
                type: 'IN',
                qty: stockQty,
                movedAt: orderMovedAt,
                note: `订单 ${orderBefore.code ?? id} 取消释放库存（原状态: ${prevStatus}）`,
                sourceType: 'ORDER',
                sourceId: id,
                sourceRef: orderBefore.code ?? id,
              },
            })
          }
        }

        // 取消关联的 Trip（任何未完成状态的 Trip）
        await prismaAny.trip.updateMany({
          where: {
            status: { in: ['PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS'] },
            restaurants: { path: '$[*].orderIds[*]', array_contains: id },
          },
          data: { status: 'CANCELLED' },
        }).catch((e: unknown) => console.error('[Trip cancel on order cancel]', e))
      }

      const changes = diffChanges(
        orderBefore as unknown as Record<string, unknown>,
        order as unknown as Record<string, unknown>,
        ORDER_TRACKED_FIELDS,
      )
      if (Array.isArray(linesPayload) && linesPayload.length > 0) {
        changes['lines'] = { before: `${linesPayload.length} 条`, after: `单价已更新` }
      }
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order', resourceId: id,
        detail: Array.isArray(linesPayload) && linesPayload.length > 0
          ? `更新订单商品明细: ${id}（${linesPayload.length} 条行）`
          : `更新订单: ${id}${newStatus ? ` → 状态: ${newStatus}` : ''}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      })

      // 订单确认后低库存提醒(旁路,失败不影响主流程)
      if (newStatus === 'CONFIRMED' && String(orderBefore.status).toUpperCase() !== 'CONFIRMED') {
        const items = (order.items as unknown as { productId?: string }[]) ?? []
        await notifyLowStockAfterConfirm(
          items.map(it => it.productId).filter((v): v is string => !!v),
          (order as { code?: string | null }).code ?? id,
        )
      }
      return NextResponse.json(serializeApi(order))
    } catch (error) {
      if (error instanceof WavePickLockedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/orders/[id]]', error)
      return NextResponse.json({ error: '更新订单失败' }, { status: 500 })
    }
  })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const orderToDelete = await prisma.order.findUnique({ where: { id }, select: { status: true, code: true } })
      if (!orderToDelete) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (String(orderToDelete.status).toUpperCase() !== 'PENDING') {
        return NextResponse.json({ error: '只有报价单（待处理状态）可以删除' }, { status: 409 })
      }
      await prisma.order.delete({ where: { id } })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'order', resourceId: id,
        detail: `删除报价单: ${orderToDelete.code ?? id}`,
      })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/orders/[id]]', error)
      return NextResponse.json({ error: '删除订单失败' }, { status: 500 })
    }
  })
}
