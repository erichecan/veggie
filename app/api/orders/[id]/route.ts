import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { notifyLowStockAfterConfirm } from '@/lib/notify'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

const ORDER_TRACKED_FIELDS = [
  'status', 'paymentMethod', 'totalAmount',
  'confirmationDate', 'deliveryDate', 'invoiceDate', 'quotationDate',
  'internalNote', 'pricelistId', 'priceType', 'restaurantName',
  'driverSlotId', 'deliveryBatch',
]

const VALID_PRICE_TYPES = new Set(['multi', 'default', 'last'])

// ── P1-6: CONFIRMED 状态下允许安全编辑的字段 ──────────────────────────────
const CONFIRMED_SAFE_FIELDS = new Set([
  'deliveryDate', 'internalNote', 'driverSlotId', 'salesman',
  'deliveryBatch', 'paymentMethod', 'confirmationDate', 'invoiceDate', 'quotationDate',
])

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
          include: { product: { select: { commissionPrice: true, standardPrice: true, internalRef: true } } },
        },
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      },
    })
    if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    // Flatten product fields onto each line so UI can read l.commissionPrice / l.cost
    const enrichedOrder = {
      ...order,
      lines: order.lines.map(({ product, ...line }) => ({
        ...line,
        commissionPrice: toNum(product?.commissionPrice),
        cost: toNum(product?.standardPrice),
        internalRef: product?.internalRef ?? null,
      })),
    }
    return NextResponse.json(serializeApi(enrichedOrder))
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
      const { confirmationDate, deliveryDate, invoiceDate, quotationDate, internalNote, status, paymentMethod, salesman, deliveryBatch, driverSlotId, pricelistId, priceType, lines: linesPayload, totalAmount: totalAmountPayload } = data

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

      // ── P0-1 + P1-6: CONFIRMED/WAVE_ASSIGNED 安全编辑 + 库存差额调整 ─────────
      // CONFIRMED 以上状态（非 PENDING）：如果修改了行（lines）或价格等非安全字段，
      // 不阻断操作，但自动标记 editApprovalRequired=true，等待管理层复核。
      // P0-1: 行修改同时计算库存差额（复用 IN_DELIVERY 的差额逻辑）。
      const currentStatus = String(orderBefore.status).toUpperCase()
      const postConfirmStatuses = new Set(['CONFIRMED', 'WAVE_ASSIGNED'])
      let flagApproval = false
      // P0-1: 标记是否需要做库存差额调整（CONFIRMED/WAVE_ASSIGNED 已扣过库存）
      const needStockDelta = postConfirmStatuses.has(currentStatus) && !newStatus && Array.isArray(data.lines)

      if (postConfirmStatuses.has(currentStatus) && !newStatus) {
        // 有行修改 → 标记需审批
        if (Array.isArray(data.lines)) {
          flagApproval = true
        }
        // 检查是否有非安全字段被修改
        const incomingKeys = Object.keys(data).filter(k => k !== 'lines' && k !== 'totalAmount' && data[k] !== undefined)
        const hasUnsafeField = incomingKeys.some(k => !CONFIRMED_SAFE_FIELDS.has(k))
        if (hasUnsafeField) flagApproval = true
      }

      // Build update payload — only include defined values (never spread unknown fields)
      const updateData: Record<string, unknown> = {}
      if (flagApproval) updateData.editApprovalRequired = true
      if (newStatus) updateData.status = newStatus
      if (salesman !== undefined) updateData.salesman = salesman ? String(salesman) : null
      if (deliveryBatch !== undefined) updateData.deliveryBatch = deliveryBatch ? String(deliveryBatch) : null
      if (driverSlotId !== undefined) updateData.driverSlotId = driverSlotId || null
      if (paymentMethod) updateData.paymentMethod = String(paymentMethod).toUpperCase()
      if (confirmationDate !== undefined) updateData.confirmationDate = confirmationDate ? new Date(confirmationDate) : null
      if (deliveryDate !== undefined) updateData.deliveryDate = deliveryDate ? new Date(deliveryDate) : null
      if (invoiceDate !== undefined) updateData.invoiceDate = invoiceDate ? new Date(invoiceDate) : null
      if (quotationDate !== undefined) updateData.quotationDate = quotationDate ? new Date(quotationDate) : null
      if (internalNote !== undefined) updateData.internalNote = internalNote ? String(internalNote).slice(0, 30) : null
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

        for (const l of linesPayload as Record<string, unknown>[]) {
          const lineData: Record<string, unknown> = {
            orderedQty: Number(l.orderedQty),
            unitPrice: Number(l.unitPrice),
            subtotal: Number(l.subtotal),
          }
          if (l.taxRate !== undefined) lineData.taxRate = Number(l.taxRate)
          if (l.sequence !== undefined) lineData.sequence = Number(l.sequence)

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
                uomId: l.uomId ? String(l.uomId) : null,
                uomName: l.uomName ? String(l.uomName) : null,
                deliveredQty: 0,
                invoicedQty: 0,
                sequence: Number(l.sequence ?? 0),
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
            await prismaAnyLines.product.update({
              where: { id: oldLine.productId },
              data: { qtyOnHand: { increment: releaseQty } },
            })
            await prismaAnyLines.stockMove.create({
              data: {
                productId: oldLine.productId,
                productName: oldLine.productName ?? '',
                type: 'IN',
                qty: releaseQty,
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
              await prismaAnyLines.product.update({
                where: { id: productId },
                data: { qtyOnHand: { decrement: qty } },
              })
              await prismaAnyLines.stockMove.create({
                data: {
                  productId,
                  productName: String(l.productName ?? ''),
                  type: 'OUT',
                  qty: -qty,
                  movedAt: orderMovedAt,
                  note: `订单 ${orderBefore.code ?? id} ${statusLabel}新增行扣减`,
                  sourceType: 'ORDER',
                  sourceId: id,
                  sourceRef: orderBefore.code ?? id,
                },
              })
            } else {
              // 已有行：检查数量变化
              const oldLine = currentLineMap.get(String(l.id))
              if (!oldLine || !oldLine.product || oldLine.product.template?.type !== 'PRODUCT') continue
              const oldQty = toNum(oldLine.orderedQty)
              const newQty = Number(l.orderedQty)
              const delta = newQty - oldQty
              if (delta === 0) continue

              if (delta > 0) {
                // 增加数量 → 额外扣减
                await prismaAnyLines.product.update({
                  where: { id: oldLine.productId },
                  data: { qtyOnHand: { decrement: delta } },
                })
                await prismaAnyLines.stockMove.create({
                  data: {
                    productId: oldLine.productId,
                    productName: oldLine.productName ?? '',
                    type: 'OUT',
                    qty: -delta,
                    movedAt: orderMovedAt,
                    note: `订单 ${orderBefore.code ?? id} ${statusLabel}增量 ${oldQty}→${newQty}`,
                    sourceType: 'ORDER',
                    sourceId: id,
                    sourceRef: orderBefore.code ?? id,
                  },
                })
              } else {
                // 减少数量 → 释放差额
                const release = Math.abs(delta)
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
                    note: `订单 ${orderBefore.code ?? id} ${statusLabel}减量 ${oldQty}→${newQty}`,
                    sourceType: 'ORDER',
                    sourceId: id,
                    sourceRef: orderBefore.code ?? id,
                  },
                })
              }
            }
          }
        }

        const computedTotal = (linesPayload as Record<string, unknown>[]).reduce((s, l) => s + Number(l.subtotal), 0)
        updateData.totalAmount = computedTotal
      } else if (totalAmountPayload !== undefined) {
        updateData.totalAmount = Number(totalAmountPayload)
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

      // Determine audit action
      let auditAction = 'updated'
      if (flagApproval) auditAction = 'edited_post_confirm'
      else if (newStatus === 'CONFIRMED') auditAction = 'confirmed'
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
      if (salesman !== undefined && salesman !== (orderBefore as unknown as Record<string, unknown>).salesman) {
        auditChangedFields.salesman = { before: (orderBefore as unknown as Record<string, unknown>).salesman ?? null, after: salesman || null }
      }
      if (deliveryDate !== undefined) {
        const oldDd = orderBefore.deliveryDate ? new Date(orderBefore.deliveryDate).toISOString().slice(0, 10) : null
        const newDd = deliveryDate ? new Date(deliveryDate).toISOString().slice(0, 10) : null
        if (oldDd !== newDd) auditChangedFields.deliveryDate = { before: oldDd, after: newDd }
      }
      if (internalNote !== undefined && internalNote !== (orderBefore as unknown as Record<string, unknown>).internalNote) {
        auditChangedFields.internalNote = { before: (orderBefore as unknown as Record<string, unknown>).internalNote ?? null, after: internalNote || null }
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

          const onHand = toNum(line.product.qtyOnHand)
          if (onHand < qty) {
            console.warn(`[order confirm] 库存不足（允许继续）: ${line.productName} 现有 ${onHand}，需要 ${qty}`)
          }

          await prismaAny.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { decrement: qty } },
          })
          await prismaAny.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'OUT',
              qty: -qty,
              movedAt: orderMovedAt,
              note: `订单 ${orderBefore.code ?? id} 确认预留`,
              sourceType: 'ORDER',
              sourceId: id,
              sourceRef: orderBefore.code ?? id,
            },
          })
        }
      }

      // On CONFIRMED: create DeliverySlip + PENDING_ASSIGNMENT Trip if not exists
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
        // Create a PENDING_ASSIGNMENT trip so dispatch can assign a driver
        await prismaAny.trip.create({
          data: {
            status: 'PENDING_ASSIGNMENT',
            restaurants: [{
              restaurantId: orderBefore.restaurantId,
              restaurantName: orderBefore.restaurantName,
              orderIds: [id],
              items: orderBefore.items,
              delivered: false,
              returns: [],
              pods: [],
              cargoVerified: false,
            }],
            totalPayment: toNum(orderBefore.totalAmount),
          },
        }).catch((e: unknown) => console.error('[Trip PENDING_ASSIGNMENT create]', e))
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

          await prismaAny.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: qty } },
          })
          await prismaAny.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'IN',
              qty,
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
            await prismaAny.product.update({
              where: { id: line.productId },
              data: { qtyOnHand: { increment: qty } },
            })
            await prismaAny.stockMove.create({
              data: {
                productId: line.productId,
                productName: line.productName ?? '',
                type: 'IN',
                qty,
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
