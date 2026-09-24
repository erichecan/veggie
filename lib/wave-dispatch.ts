import { prisma } from '@/lib/db'
import { createTripFromWave } from '@/lib/trip-from-wave'
import { toDayKey } from '@/lib/analytics/metrics'

export type DispatchWaveResult =
  | { ok: true; waveId: string; updatedCount: number; tripId: string | null; deliveryDate: Date }
  | { ok: false; waveId: string; reason: string }

/** 内部哨兵：并发竞态里没抢到「确认出发」这把锁，不是真的业务错误，转成普通失败结果处理。 */
class DispatchRaceLostError extends Error {}

/**
 * 确认出发核心逻辑：把波次内订单交货日期回填为排程日、状态推进到 IN_DELIVERY，
 * 波次标记 dispatchedAt（防重复出发），并按波次生成司机 Trip。
 *
 * 三处调用方共用同一份实现，不各写一遍：
 * - 单个批次的 `/api/waves/[id]/dispatch`（原有功能，逐批次点击）
 * - 「确认全部出发」批量按钮（前端对当天所有未出发波次逐个 apiPut 同一路由，见 BatchTab.tsx）
 * - 22 点自动兜底 cron（`/api/cron/auto-confirm-departure`，本函数直接调用，不经 HTTP）
 *
 * 库存口径（20260922 已与用户确认）：出发这一步**不改动 qtyOnHand**——库存在订单
 * CONFIRMED 时已作为预留扣过一次，这里不重复扣减，避免破坏 ATP/预测/毛利分析等
 * 一切依赖"确认即扣库存"这个既有口径的报表。"已出库"这个状态直接由
 * `status=IN_DELIVERY` + `dispatchedAt` 承载，不新增字段。
 */
export async function dispatchWave(waveId: string, fallbackDateStr?: string): Promise<DispatchWaveResult> {
  const wave = await prisma.pickingWave.findUnique({ where: { id: waveId } })
  if (!wave) return { ok: false, waveId, reason: '波次不存在' }
  if (wave.dispatchedAt) return { ok: false, waveId, reason: '该批次已确认出发' }

  const orderIds = wave.orderIds ?? []
  if (orderIds.length === 0) return { ok: false, waveId, reason: '该批次没有订单，无法出发' }

  const deliveryDate = wave.waveDate
    ?? (fallbackDateStr ? new Date(`${fallbackDateStr}T00:00:00Z`) : null)
  if (!deliveryDate) return { ok: false, waveId, reason: '缺少排程日期，无法确定交货日期' }

  try {
    const { updated, trip } = await prisma.$transaction(async (tx) => {
      // 用「条件 updateMany」当互斥锁，而不是先查一次再单独 update：同一波次被并发调用两次
      // （比如22点 cron 撞上运营手工点「确认全部出发」）时，Postgres 对同一行的两个并发
      // UPDATE 会让后到者阻塞到先到者提交，再按 WHERE dispatchedAt IS NULL 重新核对——
      // 此时已不满足，affected count = 0，安全退出，不会重复推进订单状态、不会重复生成 Trip。
      // 之前的写法是函数最上面单独 SELECT 判断 dispatchedAt 再在事务里 update，两次并发
      // 调用能同时通过那次 SELECT，各自生成一条 Trip（Trip.waveId 无唯一约束）——
      // /code-review high 指出后改成这个版本。
      // 出发即视为拣货阶段结束：一并清掉 pickLockedAt/pickLockedBy，否则波次会一直
      // 挂着「拣货中」标签（BatchTab.tsx 的 locked 判定），跟「已出发」同时显示，
      // 两个独立字段各管各的、互不联动是原本的缺口（20260924 补上）。
      const lockUpd = await tx.pickingWave.updateMany({
        where: { id: waveId, dispatchedAt: null },
        data: { dispatchedAt: new Date(), pickLockedAt: null, pickLockedBy: null },
      })
      if (lockUpd.count === 0) throw new DispatchRaceLostError()

      const upd = await tx.order.updateMany({
        where: { id: { in: orderIds }, status: { in: ['CONFIRMED', 'WAVE_ASSIGNED'] } },
        data: { deliveryDate, status: 'IN_DELIVERY' },
      })
      await tx.deliverySlip.updateMany({
        where: { orderId: { in: orderIds } },
        data: { deliveryDate },
      })
      const t = await createTripFromWave(tx as never, waveId)
      return { updated: upd, trip: t }
    })

    return { ok: true, waveId, updatedCount: updated.count, tripId: trip?.id ?? null, deliveryDate }
  } catch (e) {
    if (e instanceof DispatchRaceLostError) return { ok: false, waveId, reason: '该批次已确认出发' }
    throw e
  }
}

/**
 * 业务时区（都柏林）「今天」的日历日，格式 YYYY-MM-DD。
 *
 * 复用 `lib/analytics/metrics.ts` 的 `toDayKey`（同一套时区/夏令时换算逻辑），不在这里
 * 重新实现一遍——避免以后 BUSINESS_TIMEZONE 或夏令时处理改了，这边悄悄跟不上。
 *
 * ⛔ 不要用 `businessTodayStart()`——那个返回的是真实 UTC 时间戳，夏令时期间比 UTC
 * 零点早 1 小时；拿去跟 `waveDate` 这种朴素 UTC 零点的"纯日期"字段比较，会把"今天"
 * 自己的波次也判断成"还没到"而漏兜底。`toDayKey` 是先按都柏林时区拆出年月日再拼回
 * `YYYY-MM-DD` 字符串，与 `waveDate` 的朴素日期语义一致。
 */
export function businessTodayDateOnly(): string {
  return toDayKey(new Date())
}
