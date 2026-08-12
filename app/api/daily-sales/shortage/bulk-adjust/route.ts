/**
 * POST /api/daily-sales/shortage/bulk-adjust —— 缺货批量改单 / 转单（台账 D6）
 * ============================================================================
 * 仓库报缺 → 缺货 tab 列出全部受影响订单行 → 勾选若干行，一次性处理：
 *   · mode='ADJUST'：批量改量（含改成 0 = 删行）
 *   · mode='DEFER' ：今日按 newQty 送，差额**转到次日**（为该客户建一张 PENDING 补送单）
 * 两种模式都**必须带缺货原因**（reasonCode），原因写进 ActionLog 与 OrderAuditLog 两条
 * 已有的审计轨迹，缺货 tab 的操作记录与订单 chatter 都能看到（见 lib/shortage-reason.ts）。
 *
 * ── 与拣货锁（pickLockedAt）的优先级（台账 D6 要求先定的那件事）────────────────
 * 采用 PRD Feature D 的口径，也是代码现状：**减量/删行放行，加量拦截**。
 *   理由：拣货锁是打印拣货单时自动上的，而缺货恰恰是拣货过程中发现的 —— 若彻底锁死，
 *   每次缺货都要「找打印员解锁 → 改量 → 重打」，缺货 tab 基本没法用。
 *   反过来，加量必须先解锁：否则等于借缺货接口在锁定期间偷偷加单，纸面与实物对不上。
 * （20260708 曾按"彻底锁"改过一版，20260718 的提交又按 PRD 放开了减量。
 *   两个口径并存了很久没人明说，这里定死并用测试钉住。）
 * 本接口只允许 newQty <= oldQty —— 缺货处理天然只会减少，加量请走订单编辑。
 *
 * 逐单独立事务：一张单被锁/状态不允许，不该连累其它单一起回滚。结果分
 * applied / blocked 两组返回，前端分别展示，不是笼统的「N 条失败」。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { syncOrderItemsSnapshot } from '@/lib/order-items'
import { applyLineStockDelta } from '@/lib/order-line-stock'
import { assertOrderNotPickLockedForLineEdit, WavePickLockedError } from '@/lib/wave-pick-lock'
import { nextOrderCode, getInitials } from '@/lib/order-code'
import {
  formatShortageReason,
  parseShortageReason,
  type ShortageReasonCode,
} from '@/lib/shortage-reason'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UNEDITABLE_STATUSES = ['LOCKED', 'CANCELLED', 'COMPLETED']

type Mode = 'ADJUST' | 'DEFER'
type BlockReason = 'ORDER_NOT_FOUND' | 'LINE_NOT_FOUND' | 'ORDER_STATUS' | 'PICK_LOCKED' | 'INVALID_QTY' | 'ERROR'

interface ItemInput { orderId?: unknown; lineId?: unknown; newQty?: unknown }

interface Applied {
  orderId: string
  orderCode: string
  lineId: string
  productName: string
  oldQty: number
  newQty: number
  deferredQty?: number
  deferOrderId?: string
  deferOrderCode?: string
}

interface Blocked {
  orderId: string
  orderCode: string
  lineId: string
  reason: BlockReason
  message: string
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000)
}

/** 次日补送单的识别前缀：find-or-create 时靠它把同客户同日的补送单归到一张 */
const DEFER_NOTE_PREFIX = '缺货转单'

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as {
        mode?: unknown
        items?: unknown
        deferDate?: unknown
        reasonCode?: unknown
        reasonNote?: unknown
      }
      const mode: Mode = body.mode === 'DEFER' ? 'DEFER' : 'ADJUST'
      const reason = parseShortageReason(body)
      // 原因是硬要求（需求「每次操作写入缺货原因并可追溯」）。不给默认值——
      // 默认成 OTHER 等于让「没人填」和「确实是其他」长得一样，追溯就废了。
      if (!reason.code) {
        return NextResponse.json({ error: '请选择缺货原因（reasonCode）' }, { status: 400 })
      }
      const items = Array.isArray(body.items) ? (body.items as ItemInput[]) : []
      if (items.length === 0) {
        return NextResponse.json({ error: '请至少选择一行' }, { status: 400 })
      }

      const applied: Applied[] = []
      const blocked: Blocked[] = []
      /** customerId::date → 该客户的次日补送单 */
      const deferOrders = new Map<string, { id: string; code: string; date: string }>()
      const initials = getInitials(user.name, user.email)
      const reasonSuffix = formatShortageReason({ reasonCode: reason.code, reasonNote: reason.note })

      for (const raw of items) {
        const orderId = String(raw.orderId ?? '')
        const lineId = String(raw.lineId ?? '')
        const newQty = Number(raw.newQty)

        const order = orderId
          ? await prisma.order.findUnique({
              where: { id: orderId },
              select: {
                id: true, code: true, status: true, deliveryDate: true,
                restaurantId: true, restaurantName: true, salesUserId: true,
                commissionRate: true, commissionFixed: true, pricelistId: true, priceType: true,
              },
            })
          : null
        if (!order) {
          blocked.push({ orderId, orderCode: orderId.slice(-6), lineId, reason: 'ORDER_NOT_FOUND', message: '订单不存在' })
          continue
        }
        const orderCode = order.code ?? order.id.slice(-6)

        if (UNEDITABLE_STATUSES.includes(order.status)) {
          blocked.push({ orderId, orderCode, lineId, reason: 'ORDER_STATUS', message: `订单状态 ${order.status} 不允许改明细` })
          continue
        }

        const line = await prisma.orderLine.findUnique({
          where: { id: lineId },
          select: {
            id: true, orderId: true, productId: true, productName: true, spec: true, note: true,
            uomId: true, uomName: true, unitPrice: true, taxRate: true, orderedQty: true,
            commissionPrice: true,
          },
        })
        if (!line || line.orderId !== orderId) {
          blocked.push({ orderId, orderCode, lineId, reason: 'LINE_NOT_FOUND', message: '订单行不存在' })
          continue
        }

        const oldQty = Number(line.orderedQty)
        if (!Number.isFinite(newQty) || newQty < 0) {
          blocked.push({ orderId, orderCode, lineId, reason: 'INVALID_QTY', message: '数量无效' })
          continue
        }
        if (newQty > oldQty) {
          blocked.push({
            orderId, orderCode, lineId, reason: 'INVALID_QTY',
            message: `缺货处理只能减量（原 ${oldQty}，填了 ${newQty}）；如需加量请走订单编辑`,
          })
          continue
        }
        if (mode === 'DEFER' && newQty === oldQty) {
          blocked.push({ orderId, orderCode, lineId, reason: 'INVALID_QTY', message: '转单数量为 0，没有要转的量' })
          continue
        }

        try {
          // 减量/删行在拣货锁下放行，加量拦截（见文件头）。这里 newQty<=oldQty 恒成立，
          // 这一行是把口径显式写在执行路径上，而不是靠上面的校验隐式保证。
          await assertOrderNotPickLockedForLineEdit(orderId, newQty <= oldQty)
        } catch (e) {
          if (e instanceof WavePickLockedError) {
            blocked.push({ orderId, orderCode, lineId, reason: 'PICK_LOCKED', message: e.message })
            continue
          }
          throw e
        }

        const deferredQty = mode === 'DEFER' ? oldQty - newQty : 0
        const deferDateStr = typeof body.deferDate === 'string' && body.deferDate
          ? body.deferDate
          : (order.deliveryDate ? addDays(order.deliveryDate, 1) : addDays(new Date(), 1)).toISOString().slice(0, 10)

        try {
          const result = await prisma.$transaction(async (tx) => {
            if (newQty === 0) {
              await tx.orderLine.delete({ where: { id: lineId } })
            } else {
              const subtotal = Math.round(Number(line.unitPrice) * newQty * 100) / 100
              await tx.orderLine.update({ where: { id: lineId }, data: { orderedQty: newQty, subtotal } })
            }

            // 今日这张单少送了，差额库存回到仓库（连流水一起写，见 lib/order-line-stock.ts）
            await applyLineStockDelta(tx as never, {
              productId: line.productId,
              productName: line.productName,
              oldQty, newQty, uomId: line.uomId,
              reasonLabel: mode === 'DEFER' ? '缺货转次日' : '缺货减量',
              orderId, orderCode,
            })

            const remaining = await tx.orderLine.findMany({ where: { orderId }, select: { subtotal: true } })
            const newTotal = remaining.reduce((s, l) => s + Number(l.subtotal), 0)
            await tx.order.update({ where: { id: orderId }, data: { totalAmount: Math.round(newTotal * 100) / 100 } })
            await syncOrderItemsSnapshot(tx, orderId)

            let deferInfo: { id: string; code: string } | null = null
            if (deferredQty > 0) {
              const key = `${order.restaurantId}::${deferDateStr}`
              const cached = deferOrders.get(key)
              const deliveryDate = new Date(`${deferDateStr}T00:00:00.000Z`)
              let target = cached ? { id: cached.id, code: cached.code } : null

              if (!target) {
                // 同客户同一转入日只建一张补送单：一次处理十几行会建十几张单，
                // 司机第二天要拿十几张纸送同一家
                const existing = await tx.order.findFirst({
                  where: {
                    restaurantId: order.restaurantId,
                    deliveryDate,
                    status: 'PENDING',
                    internalNote: { startsWith: DEFER_NOTE_PREFIX },
                  },
                  select: { id: true, code: true },
                })
                if (existing) {
                  target = { id: existing.id, code: existing.code ?? existing.id.slice(-6) }
                } else {
                  const code = await nextOrderCode(tx, initials, new Date())
                  const created = await tx.order.create({
                    data: {
                      code,
                      createdById: user.userId,
                      createdByName: user.name,
                      restaurantId: order.restaurantId,
                      restaurantName: order.restaurantName,
                      items: [],
                      totalAmount: 0,
                      // 刻意建成 PENDING：确认才扣库存，而这批货正是**现在没有**的东西。
                      // 等货到了由运营确认，库存扣减自然发生在有货的那一刻。
                      status: 'PENDING',
                      deliveryDate,
                      quotationDate: new Date(),
                      pricelistId: order.pricelistId,
                      priceType: order.priceType,
                      salesUserId: order.salesUserId ?? undefined,
                      commissionRate: order.commissionRate,
                      commissionFixed: order.commissionFixed,
                      internalNote: `${DEFER_NOTE_PREFIX}：由 ${orderCode} 缺货转入${reasonSuffix}`,
                    },
                    select: { id: true, code: true },
                  })
                  target = { id: created.id, code: created.code ?? created.id.slice(-6) }
                }
                deferOrders.set(key, { ...target, date: deferDateStr })
              }

              // 价格用**原单快照**，不重新定价：客户是因为我们缺货才顺延的，
              // 不该顺带按次日价格重算（涨了显得趁火打劫，跌了公司白亏）
              const existingLine = await tx.orderLine.findFirst({
                where: { orderId: target.id, productId: line.productId, uomId: line.uomId },
                select: { id: true, orderedQty: true },
              })
              if (existingLine) {
                const merged = Number(existingLine.orderedQty) + deferredQty
                await tx.orderLine.update({
                  where: { id: existingLine.id },
                  data: {
                    orderedQty: merged,
                    subtotal: Math.round(Number(line.unitPrice) * merged * 100) / 100,
                  },
                })
              } else {
                await tx.orderLine.create({
                  data: {
                    orderId: target.id,
                    productId: line.productId,
                    productName: line.productName,
                    spec: line.spec,
                    note: line.note,
                    uomId: line.uomId,
                    uomName: line.uomName,
                    unitPrice: line.unitPrice,
                    taxRate: line.taxRate,
                    orderedQty: deferredQty,
                    subtotal: Math.round(Number(line.unitPrice) * deferredQty * 100) / 100,
                    commissionPrice: line.commissionPrice,
                  },
                })
              }
              const targetLines = await tx.orderLine.findMany({ where: { orderId: target.id }, select: { subtotal: true } })
              await tx.order.update({
                where: { id: target.id },
                data: { totalAmount: Math.round(targetLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100 },
              })
              await syncOrderItemsSnapshot(tx, target.id)
              deferInfo = target
            }

            await tx.orderAuditLog.create({
              data: {
                orderId,
                userId: user.userId,
                action: 'shortage_adjust',
                changedFields: {
                  mode,
                  productId: line.productId,
                  productName: line.productName,
                  oldQty, newQty, deferredQty,
                  reasonCode: reason.code as ShortageReasonCode,
                  reasonNote: reason.note,
                  deferOrderCode: deferInfo?.code ?? null,
                },
                totalBefore: null,
                totalAfter: Math.round(newTotal * 100) / 100,
              },
            })

            return deferInfo
          })

          const deferInfo = result
          await writeLog({
            userId: user.userId, userEmail: user.email, userName: user.name,
            action: 'UPDATE', resource: 'order', resourceId: orderId,
            detail: (newQty === 0
              ? `删除订单行: ${line.productName}（原数量 ${oldQty}，新数量 0）`
              : `修改订单行数量: ${line.productName}（${oldQty} → ${newQty}）`)
              + (deferredQty > 0 && deferInfo ? ` · 转次日 ${deferredQty} 至 ${deferInfo.code}` : '')
              + reasonSuffix,
          })

          applied.push({
            orderId, orderCode, lineId,
            productName: line.productName,
            oldQty, newQty,
            ...(deferredQty > 0
              ? { deferredQty, deferOrderId: deferInfo?.id, deferOrderCode: deferInfo?.code }
              : {}),
          })
        } catch (e) {
          console.error('[shortage bulk-adjust]', orderCode, e)
          blocked.push({
            orderId, orderCode, lineId, reason: 'ERROR',
            message: e instanceof Error ? e.message : '处理失败',
          })
        }
      }

      return NextResponse.json({
        ok: blocked.length === 0,
        applied,
        blocked,
        deferOrders: [...deferOrders.entries()].map(([key, v]) => ({
          customerId: key.split('::')[0], orderId: v.id, code: v.code, date: v.date,
        })),
      })
    } catch (error) {
      console.error('[POST /api/daily-sales/shortage/bulk-adjust]', error)
      return NextResponse.json(
        { error: '批量处理失败', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }, { require: 'sales.daily_report.manage' })
}
