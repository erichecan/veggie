import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, effectiveRoles, userHasPermission } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { syncOrderStock } from '@/lib/order-stock'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { removeOrderFromAllWaves } from '@/lib/wave-assign'
import { WavePickLockedError } from '@/lib/wave-pick-lock'
import { createDraftInvoiceForOrder } from '@/lib/invoice-from-order'
import { recalcOrderCommission, recalcTripDriverCommission } from '@/lib/commission'

/**
 * POST /api/orders/bulk
 * body: { ids: string[], action: BulkAction, value?: boolean, fields?: Record<string,unknown> }
 *
 * Actions:
 *   cancel          → status=COMPLETED（暂）      权限: OPERATOR / BOSS
 *   delete          → 物理删除                   权限: OPERATOR / BOSS
 *   mark_returned   → returnStatus=PENDING/RETURNED/ISSUE
 *                     权限: finance.write_off.confirm（核销/重置）或 .return（退回核实）
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
      const { ids, action, value, fields, status, note, lines } = body as {
        ids: string[]
        action: BulkAction
        value?: boolean
        fields?: Record<string, unknown>
        /** mark_returned 专用：三态 */
        status?: 'PENDING' | 'RETURNED' | 'ISSUE'
        /** mark_returned=ISSUE 时必填：问题说明 */
        note?: string
        /** mark_returned=RETURNED 专用，可选：核销时顺手修正实际送达数量（只能单订单操作，20261026） */
        lines?: Array<{ orderLineId: string; deliveredQty: number }>
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
        select: { id: true, status: true, restaurantName: true, deliveryDate: true, returnStatus: true },
      })
      if (before.length === 0) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      // ── 权限检查 ──────────────────────────────────────────────────────────────
      // ⛔ 20260901：原来只看 user.role（单值主角色），兼任角色（如主角色 SALES、
      // 兼任 OPERATOR/BOSS）永远判不过，即使 route-map 那层已经放行。改用
      // effectiveRoles（roles[] 优先，回退单 role），与 withAuth 内部同一套口径。
      const roles = effectiveRoles(user)
      const isOperatorOrBoss = roles.some(r => ['OPERATOR', 'BOSS'].includes(r))

      if (action === 'mark_returned') {
        if (!['PENDING', 'RETURNED', 'ISSUE'].includes(String(status))) {
          return NextResponse.json({ error: 'status 必须是 PENDING/RETURNED/ISSUE 之一' }, { status: 400 })
        }
        if (status === 'ISSUE' && !note?.trim()) {
          return NextResponse.json({ error: '退回核实必须填写问题说明' }, { status: 400 })
        }
        const need = status === 'ISSUE' ? 'finance.write_off.return' : 'finance.write_off.confirm'
        if (!userHasPermission(user, need)) {
          return NextResponse.json({ error: '权限不足' }, { status: 403 })
        }
        // ⛔ 20261026：核销时修正实际送达数量——发票/提成都按核销时的数量算，不能在核销前
        // 先判断"有没有差异"（核销本身才是核对的那一步，鸡生蛋），所以放这里；只对单订单生效，
        // 批量核销走默认送达量，有差异的单必须逐单打开编辑。
        if (lines !== undefined) {
          if (status !== 'RETURNED' || ids.length !== 1) {
            return NextResponse.json({ error: '修正送达数量只能在单张订单核销确认时进行' }, { status: 400 })
          }
          if (!Array.isArray(lines) || lines.length === 0) {
            return NextResponse.json({ error: 'lines 格式不正确' }, { status: 400 })
          }
          const orderLines = await prisma.orderLine.findMany({ where: { orderId: ids[0] }, select: { id: true } })
          const validLineIds = new Set(orderLines.map(l => l.id))
          for (const l of lines) {
            if (!validLineIds.has(l.orderLineId)) {
              return NextResponse.json({ error: `订单行不存在: ${l.orderLineId}` }, { status: 400 })
            }
            const qty = Number(l.deliveredQty)
            if (!Number.isFinite(qty) || qty < 0) {
              return NextResponse.json({ error: `实际送达数量不合法: ${l.deliveredQty}` }, { status: 400 })
            }
          }
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
        const candidates = before.filter(o => cancellableStatuses.has(String(o.status).toUpperCase()))
        if (candidates.length === 0) {
          return NextResponse.json({ error: '选中订单中没有可取消的订单' }, { status: 400 })
        }

        // 取消即退出配送流程,必须同步移出波次:调度台按 wave.orderIds 取数渲染,
        // 只清状态不清波次会留下"已取消却仍占着司机托盘"的幽灵单。
        // 清理放在状态更新之前——波次已拣货锁定的单移不出去,直接踢出本次取消名单,
        // 而不是先改完状态再发现清不掉(与单单取消路径 orders/[id] 同口径)。
        const lockedIds = new Set<string>()
        for (const ord of candidates) {
          try {
            await removeOrderFromAllWaves(ord.id)
          } catch (e) {
            if (e instanceof WavePickLockedError) {
              lockedIds.add(ord.id)
              continue
            }
            throw e
          }
        }
        const cancellable = candidates.filter(o => !lockedIds.has(o.id))
        if (cancellable.length === 0) {
          return NextResponse.json({ error: '选中订单所在波次已拣货锁定，请先到每日销售解锁' }, { status: 409 })
        }
        const cancellableIds = cancellable.map(o => o.id)
        affectedOrders = cancellable.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        await prisma.order.updateMany({
          where: { id: { in: cancellableIds } },
          data: { status: 'CANCELLED' },
        })
        // 库存：只释放每张单在流水里真正拿走过的量（lib/order-stock.ts，20261014 复式改造 L3）
        for (const ordId of cancellableIds) {
          await prisma.$transaction(tx => syncOrderStock(tx, ordId, {
            reason: '批量取消释放库存', userId: user.userId, createdBy: user.name ?? user.email,
          }), { maxWait: 10000, timeout: 60000 })
        }
        detail = `批量取消 ${cancellableIds.length} 单${lockedIds.size > 0 ? `（${lockedIds.size} 单因波次已拣货锁定跳过）` : ''}`

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
        await prisma.order.updateMany({
          where: { id: { in: ids } },
          data: {
            returnStatus: status,
            returnIssueNote: status === 'ISSUE' ? note!.trim() : null,
            // 核销时间/人：核销管理页「已核销的在主列表留 24 小时」靠它；撤销/退回时清空（20261021）
            returnConfirmedAt: status === 'RETURNED' ? new Date() : null,
            returnConfirmedBy: status === 'RETURNED' ? (user.name ?? user.email) : null,
          },
        })
        if (lines !== undefined) {
          for (const l of lines) {
            await prisma.orderLine.update({ where: { id: l.orderLineId }, data: { deliveredQty: l.deliveredQty } })
          }
        }
        const label = status === 'RETURNED' ? '核销' : status === 'ISSUE' ? '退回核实' : '重置为未回'
        detail = `批量${label} ${ids.length} 单${lines !== undefined ? `（已修正 ${lines.length} 行送达数量）` : ''}`
        affectedOrders = before.map(o => ({ id: o.id, statusBefore: String(o.status), restaurantName: o.restaurantName }))

        // Write audit logs for mark_returned
        const returnStatusBefore = new Map(before.map(o => [o.id, o.returnStatus]))
        await Promise.all(affectedOrders.map(o =>
          prismaAny.orderAuditLog.create({
            data: {
              orderId: o.id,
              userId: user.userId,
              action: 'updated',
              changedFields: {
                detail: `批量${label}`,
                returnStatus: { before: returnStatusBefore.get(o.id) ?? null, after: status },
              },
            },
          }).catch((e: unknown) => console.error('[BulkAudit mark_returned]', e))
        ))

        // ⛔ 20261026：核销确认(RETURNED)才是"核对过了"的那一刻——开票按核销时(可能已修正)的
        // deliveredQty 生成，提成冻结同步跟上；标记完成时不再做这两件事（见 lib/delivery-complete.ts）。
        // 失败只记日志不回滚核销本身：核销是真实的物理动作，发票/提成失败可以用「补开漏开的发票」补。
        if (status === 'RETURNED') {
          const invoiceFailed: string[] = []
          for (const o of before) {
            try {
              await createDraftInvoiceForOrder(prisma as never, o.id)
              await recalcOrderCommission(o.id, prisma)
              const ownerTrip = await prismaAny.trip.findFirst({
                where: { restaurants: { path: '$[*].orderIds[*]', array_contains: o.id } },
                select: { id: true },
              }).catch(() => null)
              if (ownerTrip) {
                await recalcTripDriverCommission(ownerTrip.id, prisma).catch((e: unknown) => console.error('[write-off: trip commission sync]', e))
              }
            } catch (e) {
              console.error('[write-off: invoice/commission]', o.id, e)
              invoiceFailed.push(o.restaurantName ?? o.id.slice(-8))
            }
          }
          if (invoiceFailed.length > 0) {
            detail += `；⚠️ ${invoiceFailed.length} 单开票/提成失败（${invoiceFailed.join('、')}），可用「补开漏开的发票」补`
          }
        }

      } else if (action === 'confirm') {
        const pendingOrders = before.filter(o => String(o.status).toUpperCase() === 'PENDING')
        const pendingIds = pendingOrders.map(o => o.id)
        if (pendingIds.length === 0) {
          return NextResponse.json({ error: '选中订单中没有待处理状态的订单' }, { status: 400 })
        }

        await prisma.order.updateMany({
          where: { id: { in: pendingIds } },
          data: { status: 'CONFIRMED', confirmationDate: new Date() },
        })
        // 库存占用与单单确认走同一个函数（lib/order-stock.ts）
        for (const ordId of pendingIds) {
          await prisma.$transaction(tx => syncOrderStock(tx, ordId, {
            reason: '批量确认占用库存', userId: user.userId, createdBy: user.name ?? user.email,
          }), { maxWait: 10000, timeout: 60000 })
        }
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
        // 开始配送 = 货离仓：按订单行出库（lib/order-stock.ts，20261015）
        for (const ordId of confirmedIds) {
          await prisma.$transaction(tx => syncOrderStock(tx, ordId, {
            shipping: true, reason: '批量开始配送出库', userId: user.userId, createdBy: user.name ?? user.email,
          }), { maxWait: 10000, timeout: 60000 })
        }
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
  // ⛔ 20260924 发现：route-map.ts 那层外层闸门已放行 finance.write_off.confirm，
  // 但 withAuth 自己这层 require 是第二道独立闸门，之前漏改，FINANCE 请求会在
  // 进 handler 前就被这里拦成 403，route-map 的修复形同虚设。三个权限点任一即可，
  // 具体 action 允许哪个角色仍由函数体内 70-83 行按 action 精确判定，这里只负责
  // "能不能进门"。
  }, { require: ['sales.order.bulk_import', 'finance.write_off.confirm', 'finance.write_off.return'] })
}
