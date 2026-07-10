import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { consumeLotsFIFO, restoreLotsFIFO } from '@/lib/inventory'
import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * POST /api/orders/bulk
 * body: { ids: string[], action: BulkAction, value?: boolean, fields?: Record<string,unknown> }
 *
 * Actions:
 *   cancel          → status=COMPLETED（暂）      权限: OPERATOR / BOSS
 *   delete          → 物理删除                   权限: OPERATOR / BOSS
 *   mark_returned   → orderReturn=value(bool)    权限: FINANCE / OPERATOR / BOSS
 *   confirm         → status=CONFIRMED (PENDING) 权限: OPERATOR / BOSS
 *   start_delivery  → status=IN_DELIVERY         权限: OPERATOR / BOSS
 *   mass_edit       → 批量改 fields              权限: OPERATOR / BOSS
 */

const ALLOWED_ACTIONS = ['cancel', 'delete', 'mark_returned', 'confirm', 'start_delivery', 'mass_edit'] as const
type BulkAction = typeof ALLOWED_ACTIONS[number]

// C-1: 移除 deliveryBatch — 配送批次真相单一归 wave.orderIds(P0-1),不再允许批量写字符串副本
const MASS_EDIT_ALLOWED_FIELDS = new Set(['deliveryDate', 'paymentMethod', 'driverSlotId'])

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const { ids, action, value, fields } = body as {
        ids: string[]
        action: BulkAction
        value?: boolean
        fields?: Record<string, unknown>
      }

      if (!Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json({ error: '没有选中订单' }, { status: 400 })
      }
      // P1-2: 确认操作可批量 100 单；其他操作上限 500
      const maxIds = action === 'confirm' ? 100 : 500
      if (ids.length > maxIds) {
        return NextResponse.json({ error: `${action} 单次最多 ${maxIds} 条` }, { status: 400 })
      }
      if (!ALLOWED_ACTIONS.includes(action as BulkAction)) {
        return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 })
      }

      const before = await prisma.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, restaurantName: true, orderReturn: true, deliveryDate: true },
      })
      if (before.length === 0) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      // ── 权限检查 ──────────────────────────────────────────────────────────────
      const isFinance = user.role === 'FINANCE'
      const isOperatorOrBoss = ['OPERATOR', 'BOSS'].includes(user.role)

      if (action === 'mark_returned') {
        if (!isFinance && !isOperatorOrBoss) {
          return NextResponse.json({ error: '仅会计/运营/老板可批量核销' }, { status: 403 })
        }
      } else if (!isOperatorOrBoss) {
        return NextResponse.json({ error: '权限不足' }, { status: 403 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prismaAny = prisma as any

      // ── 执行操作 ──────────────────────────────────────────────────────────────
      let detail = ''
      // Collect order IDs that were actually affected (for audit log)
      let affectedOrders: { id: string; statusBefore: string; restaurantName: string | null }[] = []

      if (action === 'delete') {
        affectedOrders = before.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))
        // Write audit logs BEFORE deleting (so orderId foreign key still valid)
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'deleted',
              changedFields: {
                detail: `批量删除操作`,
                status: { before: o.statusBefore, after: 'DELETED' },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit delete]', e))
        ))
        await prisma.order.deleteMany({ where: { id: { in: ids } } })
        detail = `批量删除 ${ids.length} 单`

      } else if (action === 'cancel') {
        // 只取消非 COMPLETED / LOCKED 的订单
        const cancellableStatuses = new Set(['PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
        const cancellable = before.filter(o => cancellableStatuses.has(String(o.status).toUpperCase()))
        if (cancellable.length === 0) {
          return NextResponse.json({ error: '选中订单中没有可取消的订单' }, { status: 400 })
        }
        const cancellableIds = cancellable.map(o => o.id)
        affectedOrders = cancellable.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // 恢复已扣库存的订单（CONFIRMED / WAVE_ASSIGNED / IN_DELIVERY）
        const stockReservedStatuses = new Set(['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
        const needsStockRestore = cancellable.filter(o => stockReservedStatuses.has(String(o.status).toUpperCase()))

        for (const ord of needsStockRestore) {
          const lines = await prisma.orderLine.findMany({
            where: { orderId: ord.id },
            include: { product: { include: { template: { select: { type: true } } } } },
          })
          for (const line of lines) {
            if (!line.product || line.product.template?.type !== 'PRODUCT') continue
            const qty = toNum(line.orderedQty)
            if (qty <= 0) continue
            await prismaAny.product.update({
              where: { id: line.productId },
              data: { qtyOnHand: { increment: qty } },
            })
            await restoreLotsFIFO(prismaAny, line.productId, qty)
            await prismaAny.stockMove.create({
              data: {
                productId: line.productId,
                productName: line.productName ?? '',
                type: 'IN',
                qty,
                movedAt: ord.deliveryDate ? new Date(ord.deliveryDate as unknown as string) : new Date(),
                note: `批量取消订单释放库存`,
                sourceType: 'ORDER',
                sourceId: ord.id,
                sourceRef: null,
              },
            })
          }
        }

        await prisma.order.updateMany({
          where: { id: { in: cancellableIds } },
          data: { status: 'CANCELLED' },
        })
        detail = `批量取消 ${cancellableIds.length} 单`

        // Write audit logs for cancelled orders
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'cancelled',
              changedFields: {
                detail: `批量取消操作`,
                status: { before: o.statusBefore, after: 'CANCELLED' },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit cancel]', e))
        ))

      } else if (action === 'mark_returned') {
        const returnValue = value !== false // default true
        await prisma.order.updateMany({
          where: { id: { in: ids } },
          data: { orderReturn: returnValue },
        })
        detail = `批量${returnValue ? '核销' : '撤销核销'} ${ids.length} 单`
        affectedOrders = before.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // Write audit logs for mark_returned
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'updated',
              changedFields: {
                detail: returnValue ? '批量标记已核销' : '批量撤销核销',
                orderReturn: { before: !returnValue, after: returnValue },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit mark_returned]', e))
        ))

      } else if (action === 'confirm') {
        const pendingOrders = before.filter(o => String(o.status).toUpperCase() === 'PENDING')
        const pendingIds = pendingOrders.map(o => o.id)
        if (pendingIds.length === 0) {
          return NextResponse.json({ error: '选中订单中没有待处理状态的订单' }, { status: 400 })
        }

        // P1-2: 批量确认时同时做库存预留（每单逐行扣减 qtyOnHand）
        for (const ordId of pendingIds) {
          const ord = before.find(o => o.id === ordId)
          const bulkMovedAt = ord?.deliveryDate ? new Date(ord.deliveryDate) : new Date()
          const lines = await prisma.orderLine.findMany({
            where: { orderId: ordId },
            include: { product: { include: { template: { select: { type: true } } } } },
          })
          for (const line of lines) {
            if (!line.product || line.product.template?.type !== 'PRODUCT') continue
            const qty = toNum(line.orderedQty)
            if (qty <= 0) continue
            await prismaAny.product.update({
              where: { id: line.productId },
              data: { qtyOnHand: { decrement: qty } },
            })
            const consumed = await consumeLotsFIFO(prismaAny, line.productId, qty)
            const consumedQty = consumed.reduce((s, c) => s + c.qty, 0)
            const unmatched = round2(qty - consumedQty)
            const moveRows = consumed.map(c => ({
              productId: line.productId,
              productName: line.productName ?? '',
              type: 'OUT' as const,
              qty: -c.qty,
              lotId: c.lotId,
              movedAt: bulkMovedAt,
              note: `批量确认订单预留库存（批次 ${c.lotNumber}）`,
              sourceType: 'ORDER',
              sourceId: ordId,
              sourceRef: null,
            }))
            if (unmatched > 0) {
              moveRows.push({
                productId: line.productId,
                productName: line.productName ?? '',
                type: 'OUT' as const,
                qty: -unmatched,
                lotId: undefined as unknown as string,
                movedAt: bulkMovedAt,
                note: `批量确认订单预留库存（超卖，无批次）`,
                sourceType: 'ORDER',
                sourceId: ordId,
                sourceRef: null,
              })
            }
            for (const row of moveRows) {
              await prismaAny.stockMove.create({ data: row })
            }
          }
        }

        await prisma.order.updateMany({
          where: { id: { in: pendingIds } },
          data: { status: 'CONFIRMED', confirmationDate: new Date() },
        })
        detail = `批量确认 ${pendingIds.length} 张报价单`
        affectedOrders = pendingOrders.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // Write audit logs for confirmed orders
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'confirmed',
              changedFields: {
                detail: `批量确认操作`,
                status: { before: o.statusBefore, after: 'CONFIRMED' },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit confirm]', e))
        ))

      } else if (action === 'start_delivery') {
        const confirmedOrders = before.filter(o => String(o.status).toUpperCase() === 'CONFIRMED')
        const confirmedIds = confirmedOrders.map(o => o.id)
        if (confirmedIds.length === 0) {
          return NextResponse.json({ error: '选中订单中没有已确认状态的订单' }, { status: 400 })
        }
        await prisma.order.updateMany({
          where: { id: { in: confirmedIds } },
          data: { status: 'IN_DELIVERY' },
        })
        detail = `批量开始配送 ${confirmedIds.length} 单`
        affectedOrders = confirmedOrders.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // Write audit logs for start_delivery
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'updated',
              changedFields: {
                detail: `批量开始配送`,
                status: { before: o.statusBefore, after: 'IN_DELIVERY' },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit start_delivery]', e))
        ))

      } else if (action === 'mass_edit') {
        if (!fields || typeof fields !== 'object') {
          return NextResponse.json({ error: 'mass_edit 需要 fields 参数' }, { status: 400 })
        }
        const safeFields: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(fields)) {
          if (MASS_EDIT_ALLOWED_FIELDS.has(k) && v !== undefined && v !== '') {
            safeFields[k] = v
          }
        }
        if (Object.keys(safeFields).length === 0) {
          return NextResponse.json({ error: '没有有效的字段可更新' }, { status: 400 })
        }
        await prisma.order.updateMany({
          where: { id: { in: ids } },
          data: safeFields,
        })
        detail = `批量编辑 ${ids.length} 单 (${Object.keys(safeFields).join(', ')})`
        affectedOrders = before.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // Write audit logs for mass_edit — record which fields were changed
        const fieldDiffs: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(safeFields)) {
          fieldDiffs[k] = { before: null, after: v }
        }
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'updated',
              changedFields: {
                detail: `批量编辑: ${Object.keys(safeFields).join(', ')}`,
                ...fieldDiffs,
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit mass_edit]', e))
        ))
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: action === 'delete' ? 'DELETE' : 'UPDATE',
        resource: 'order', resourceId: ids.join(','),
        detail,
        changes: { count: { before: 0, after: ids.length } },
      })

      return NextResponse.json({ ok: true, affected: ids.length, detail })
    } catch (error) {
      console.error('[POST /api/orders/bulk]', error)
      return NextResponse.json({ error: '批量操作失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'FINANCE'])
}
