import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog, diffChanges } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

const PO_TRACKED_FIELDS = ['status', 'confirmedAt', 'cancelledAt', 'lockedAt', 'notes', 'expectedDate', 'editApprovalRequired']

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT:       ['SENT', 'CONFIRMED', 'CANCELLED'],
  SENT:        ['CONFIRMED', 'TO_APPROVE', 'CANCELLED'],
  TO_APPROVE:  ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:   ['RECEIVED', 'CANCELLED'],
  RECEIVED:    ['INVOICED', 'CANCELLED'],
  INVOICED:    ['LOCKED', 'CANCELLED'],
  LOCKED:      [],
  CANCELLED:   ['DRAFT'],
}

const PO_CONFIRMED_SAFE_FIELDS = ['notes', 'expectedDate']

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const po = await p.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } }, receipts: true, bills: true },
    })
    if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(po))
  } catch (error) {
    console.error('[GET /api/purchase-orders/:id]', error)
    return NextResponse.json({ error: '获取失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const poBefore = await p.purchaseOrder.findUnique({ where: { id }, include: { lines: true } })
      if (!poBefore) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })

      // LOCKED state is immutable
      if (poBefore.status === 'LOCKED') {
        return NextResponse.json({ error: '已锁定的采购单不可编辑' }, { status: 409 })
      }

      if (!['DRAFT', 'SENT'].includes(poBefore.status)) {
        return NextResponse.json({ error: '只有草稿/已发送状态可编辑' }, { status: 409 })
      }

      const { notes, expectedDate, supplierId, lines: linesPayload } = data

      const headerUpdate: Record<string, unknown> = {}
      if (notes !== undefined) headerUpdate.notes = notes ? String(notes) : null
      if (expectedDate !== undefined) headerUpdate.expectedDate = expectedDate ? new Date(expectedDate) : null
      if (supplierId !== undefined) headerUpdate.supplierId = String(supplierId)

      // P1-2: Capture old line state for audit
      const oldLines = (poBefore.lines as Array<Record<string, unknown>>).reduce(
        (acc: Record<string, Record<string, unknown>>, l: Record<string, unknown>) => {
          acc[l.id as string] = l
          return acc
        },
        {} as Record<string, Record<string, unknown>>,
      )
      const lineChanges: { modified: Array<{ lineId: string; productName: string; field: string; from: unknown; to: unknown }> } = { modified: [] }

      if (Array.isArray(linesPayload) && linesPayload.length > 0) {
        const lineOps = linesPayload.map((l: Record<string, unknown>) => {
          const orderedQty = Number(l.orderedQty)
          const unitCost = Number(l.unitCost)
          const taxRate = l.taxRate !== undefined ? Number(l.taxRate) : 0
          const subtotalExTax = orderedQty * unitCost
          const taxAmount = subtotalExTax * taxRate / 100
          const subtotalIncTax = subtotalExTax + taxAmount
          const bestBefore = l.bestBefore !== undefined
            ? (l.bestBefore ? new Date(l.bestBefore as string) : null)
            : undefined

          // P1-2: Detect per-line changes
          const lineId = String(l.id)
          const old = oldLines[lineId]
          if (old) {
            const pName = String(old.productName ?? '')
            if (toNum(old.orderedQty) !== orderedQty) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'orderedQty', from: toNum(old.orderedQty), to: orderedQty })
            }
            if (toNum(old.unitCost) !== unitCost) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'unitCost', from: toNum(old.unitCost), to: unitCost })
            }
            if (toNum(old.taxRate) !== taxRate) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'taxRate', from: toNum(old.taxRate), to: taxRate })
            }
          }

          return p.purchaseOrderLine.update({
            where: { id: lineId },
            data: {
              orderedQty, unitCost, taxRate, subtotalExTax, taxAmount, subtotalIncTax,
              ...(bestBefore !== undefined && { bestBefore }),
            },
          })
        })
        await prisma.$transaction(lineOps)

        // Recalculate PO totals
        const updatedLines = linesPayload as Array<Record<string, unknown>>
        let subtotalExTax = 0, totalTax = 0
        for (const l of updatedLines) {
          const qty = Number(l.orderedQty)
          const cost = Number(l.unitCost)
          const tax = l.taxRate !== undefined ? Number(l.taxRate) : 0
          const sub = qty * cost
          subtotalExTax += sub
          totalTax += sub * tax / 100
        }
        headerUpdate.subtotalExTax = subtotalExTax
        headerUpdate.totalTax = totalTax
        headerUpdate.totalIncTax = subtotalExTax + totalTax
      }

      const po = await p.purchaseOrder.update({
        where: { id },
        data: headerUpdate,
        include: { lines: { orderBy: { sequence: 'asc' } } },
      })

      const changes = diffChanges(
        poBefore as Record<string, unknown>,
        po as Record<string, unknown>,
        PO_TRACKED_FIELDS,
      )
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `编辑采购单 ${poBefore.name}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
        ...(lineChanges.modified.length > 0 && { lineChanges }),
      })

      return NextResponse.json(serializeApi(po))
    } catch (error) {
      console.error('[PUT /api/purchase-orders/:id]', error)
      return NextResponse.json({ error: '保存失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const { action } = await req.json()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.purchaseOrder.findUnique({
        where: { id },
        include: { lines: true },
      })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })

      // LOCKED is immutable — reject all actions
      if (po.status === 'LOCKED') {
        return NextResponse.json({ error: '已锁定的采购单不可变更' }, { status: 409 })
      }

      const targetStatus: string | null = ({
        send:           'SENT',
        confirm:        'CONFIRMED',
        cancel:         'CANCELLED',
        receive:        'RECEIVED',
        invoice:        'INVOICED',
        lock:           'LOCKED',
        reset_to_draft: 'DRAFT',
        approve:        'CONFIRMED',
        to_approve:     'TO_APPROVE',
      } as Record<string, string>)[action] ?? null

      if (!targetStatus) {
        return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 })
      }

      if (!(ALLOWED_TRANSITIONS[po.status] ?? []).includes(targetStatus)) {
        return NextResponse.json({
          error: `状态转换不合法: ${po.status} → ${targetStatus}`,
        }, { status: 409 })
      }

      // P0-1: Cancel check — reject if related documents exist
      if (targetStatus === 'CANCELLED') {
        const receiptCount = await p.goodsReceipt.count({ where: { purchaseOrderId: id } })
        if (receiptCount > 0) {
          return NextResponse.json({ error: '已有收货单，无法取消。请先删除收货单。' }, { status: 409 })
        }
        const activeBillCount = await p.vendorBill.count({
          where: { purchaseOrderId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        })
        if (activeBillCount > 0) {
          return NextResponse.json({ error: '已有已过账的供应商账单，无法取消。请先取消账单。' }, { status: 409 })
        }
      }

      // Build update data
      const updateData: Record<string, unknown> = {
        status: targetStatus,
      }

      // P0-2: CANCELLED → DRAFT reset — clear timestamps, keep stock as-is
      if (action === 'reset_to_draft') {
        updateData.confirmedAt = null
        updateData.cancelledAt = null
        updateData.lockedAt = null
        updateData.editApprovalRequired = false
      }

      if (targetStatus === 'CONFIRMED') {
        updateData.confirmedAt = po.confirmedAt ?? new Date()
      }
      if (targetStatus === 'CANCELLED') {
        updateData.cancelledAt = new Date()
      }
      if (targetStatus === 'LOCKED') {
        updateData.lockedAt = new Date()
      }

      const updated = await p.purchaseOrder.update({
        where: { id },
        data: updateData,
        include: { lines: true },
      })

      // On CONFIRMED: increment stock (IN)
      if (targetStatus === 'CONFIRMED' && po.status !== 'CONFIRMED') {
        const lines = po.lines as Array<{ productId: string | null; productName: string; orderedQty: unknown }>
        for (const line of lines) {
          if (!line.productId) continue
          const qty = toNum(line.orderedQty)
          if (qty <= 0) continue
          const product = await p.product.findUnique({
            where: { id: line.productId },
            include: { template: { select: { type: true } } },
          })
          if (!product || product.template?.type !== 'PRODUCT') continue
          await p.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: qty } },
          })
          await p.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'IN',
              qty,
              note: `采购单 ${po.name} 确认入库`,
              sourceType: 'PURCHASE_ORDER',
              sourceId: id,
              sourceRef: po.name,
            },
          })
        }
      }

      // On CANCELLED from CONFIRMED: reverse stock (OUT)
      if (targetStatus === 'CANCELLED' && po.status === 'CONFIRMED') {
        const lines = po.lines as Array<{ productId: string | null; productName: string; orderedQty: unknown }>
        for (const line of lines) {
          if (!line.productId) continue
          const qty = toNum(line.orderedQty)
          if (qty <= 0) continue
          const product = await p.product.findUnique({
            where: { id: line.productId },
            include: { template: { select: { type: true } } },
          })
          if (!product || product.template?.type !== 'PRODUCT') continue
          await p.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { decrement: qty } },
          })
          await p.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'OUT',
              qty: -qty,
              note: `采购单 ${po.name} 取消释放库存`,
              sourceType: 'PURCHASE_ORDER',
              sourceId: id,
              sourceRef: po.name,
            },
          })
        }
      }

      const changes = diffChanges(
        po as Record<string, unknown>,
        updated as Record<string, unknown>,
        PO_TRACKED_FIELDS,
      )
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `PO ${po.name}: ${po.status} → ${targetStatus}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PATCH /api/purchase-orders/:id]', error)
      return NextResponse.json({ error: '状态更新失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
