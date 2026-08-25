/**
 * 损耗与退货仪表盘 · 数据层
 * ============================================================================
 * 背景（见 docs 20260709 退货处置审计）：仓库报废损耗（StockMove type=SCRAP）与客户
 * 退货（Trip.restaurants[].returns[] JSON）长期是两套互不相通的数据。P0 修复给每条
 * 已审批退货加了 disposition（SELLABLE=可再售回补库存 / SCRAP=报废），SCRAP 处置会
 * 额外生成一笔 StockMove(type=SCRAP, sourceType=RETURN_SCRAP)，使其自然落入既有报废
 * 损耗统计；但"退货回收率""退货去向"这类只有退货语境才能回答的问题，仍必须回到
 * Trip JSON 里扫描 disposition 字段才能算——StockMove 本身分不清一笔 SCRAP 是客退报废
 * 还是仓库过期报废（虽然可以用 sourceType='RETURN_SCRAP' 反查客退报废子集，见
 * getLossTrend 的 returnScrapQty）。
 *
 * 已知限制（不在本次范围内修复）：
 *   - 退货没有关系型表，只能整表扫描 Trip.restaurants JSON，量大时有性能代价；
 *   - StockMove.note 里的报废原因是拼接字符串，不是结构化字段，parseReasonLabel()
 *     只做"拿括号里的文字，否则取冒号/短横线前的第一段"这种粗筛，不做严格解析。
 */

import { prisma } from '@/lib/db'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { toDayKey } from '@/lib/analytics/metrics'
import { SCRAP_REASON_LABEL } from '@/lib/scrap-reasons'
import { summarizeByStage, type StageBreakdownRow } from '@/lib/loss-attribution'
import type { TripRestaurant, ReturnItem } from '@/lib/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prisma as any

// ─── 通用工具 ─────────────────────────────────────────────────────────────────

/** 期内窗口：[今天-days+1 ~ 明天0点)，与本项目其余 analytics 口径一致（含今天） */
function periodRange(days: number): { start: Date; end: Date } {
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return { start, end }
}

/** 本周一 00:00（本地时区），全站周趋势统一按周一起算 */
function mondayStart(d: Date): Date {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  const day = date.getDay() // 0=周日 .. 6=周六
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  return date
}

function formatWeekLabel(monday: Date): string {
  const m = String(monday.getMonth() + 1).padStart(2, '0')
  const d = String(monday.getDate()).padStart(2, '0')
  return `${m}/${d}`
}

/** 从 StockMove.note 里粗筛报废原因标签：优先取括号内文字，否则取冒号/短横线前第一段 */
function parseReasonLabel(note: string | null | undefined): string {
  if (!note) return '未标注原因'
  const parenMatch = note.match(/[(（]([^)）]+)[)）]/)
  if (parenMatch && parenMatch[1].trim()) return parenMatch[1].trim()
  const seg = note.split(/[:：-]/)[0]?.trim()
  return seg || '未标注原因'
}

/**
 * 原因文案 → 原因 key。除了完整标签，**括号内的那段也登记成别名** ——
 * parseReasonLabel 优先取括号内文字，于是「到货即损坏（运输/供应商责任）」会被截成
 * 「运输/供应商责任」，用完整标签去查就永远查不中，那批记录既归不了原因也归不了环节
 * （实测本地库有 45 件因此躺在「未归因」里）。这只是**老数据的兜底**：
 * 新记录带结构化 lossReason，不走这条路。
 */
const REASON_LABEL_TO_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const [key, label] of Object.entries(SCRAP_REASON_LABEL)) {
    map[label] = key
    const inner = label.match(/[(（]([^)）]+)[)）]/)?.[1]?.trim()
    if (inner) map[inner] = key
  }
  return map
})()
function reasonKeyFromLabel(label: string): string {
  return REASON_LABEL_TO_KEY[label] ?? label
}

// ─── Trip JSON 扫描：退货去向 ──────────────────────────────────────────────────

interface ScannedReturn extends ReturnItem {
  effectiveDate: Date
}

/**
 * 扫描 Trip.restaurants[].returns[]，给每条退货算一个"生效日期"用于按期筛选：
 *   - 已审批（disposition 已写入）→ approvedAt，缺失（老数据）回退 trip.createdAt
 *   - 未审批（PENDING_REVIEW/REJECTED）→ ret.createdAt，缺失回退 trip.createdAt
 * tripWhere 可选：按 trip.createdAt 提前收窄扫描范围（approvedAt/ret.createdAt 不可能早于所属 trip 的 createdAt）。
 */
async function scanReturns(tripWhere?: { createdAt?: { lt: Date } }): Promise<ScannedReturn[]> {
  const trips = await p.trip.findMany({
    where: tripWhere,
    select: { restaurants: true, createdAt: true },
  })

  const out: ScannedReturn[] = []
  for (const t of trips as Array<{ restaurants: unknown; createdAt: Date }>) {
    const restaurants = (t.restaurants ?? []) as unknown as TripRestaurant[]
    const fallback = new Date(t.createdAt)
    for (const r of restaurants) {
      for (const ret of r.returns ?? []) {
        const rawDate = ret.disposition ? ret.approvedAt : ret.createdAt
        const parsed = rawDate ? new Date(rawDate) : null
        const effectiveDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback
        out.push({ ...ret, effectiveDate })
      }
    }
  }
  return out
}

/** 期内已审批退货按去向汇总数量（SELLABLE / SCRAP），以及期内待处置数量 */
async function getDispositionCounts(start: Date, end: Date): Promise<{
  sellableQty: number
  scrapQty: number
  pendingQty: number
}> {
  const returns = await scanReturns({ createdAt: { lt: end } })
  let sellableQty = 0
  let scrapQty = 0
  let pendingQty = 0
  for (const ret of returns) {
    if (ret.effectiveDate < start || ret.effectiveDate >= end) continue
    const qty = toNum(ret.quantity)
    if (ret.disposition === 'SELLABLE') sellableQty += qty
    else if (ret.disposition === 'SCRAP') scrapQty += qty
    else if (ret.status === 'PENDING_REVIEW') pendingQty += qty
  }
  return { sellableQty, scrapQty, pendingQty }
}

/** 当前待处置退货条数（队列深度，不按期筛选） */
async function getPendingReturnCount(): Promise<number> {
  const returns = await scanReturns()
  return returns.filter(r => r.status === 'PENDING_REVIEW').length
}

// ─── SCRAP StockMove 查询 ──────────────────────────────────────────────────────

/**
 * 报废损耗值：Σ ABS(qty) × 单价，单价取 Lot.unitCost（收货时从 PO 行写入），
 * 缺失（历史批次未回填/未指定批次）则退回 Product.standardPrice，
 * 与 app/api/analytics/procurement/route.ts 的损耗查询同一口径（COALESCE 顺序一致）。
 */
async function getScrapValueSum(start: Date, end: Date): Promise<number> {
  const rows = (await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM(ABS(sm.qty) * COALESCE(l."unitCost", pr."standardPrice", 0)), 0)::float AS amount
     FROM "StockMove" sm
     LEFT JOIN "Lot" l ON l.id = sm."lotId"
     LEFT JOIN "Product" pr ON pr.id = sm."productId"
     WHERE sm."movedAt" >= $1 AND sm."movedAt" < $2 AND sm.type = 'SCRAP'`,
    start, end,
  )) as Array<{ amount: number }>
  return rows[0]?.amount ?? 0
}

// ─── 对外导出 ─────────────────────────────────────────────────────────────────

export interface LossKPIs {
  /** 期内报废损耗值（EUR），type='SCRAP' 的 StockMove，含仓库报废与客退报废 */
  scrapValueThisPeriod: number
  /** 退货回收率 = SELLABLE 数量 / (SELLABLE+SCRAP) 数量 × 100，无已审批退货时为 null（非 0，区分"0% 回收"与"无数据"） */
  returnRecoveryRatePct: number | null
  /** 当前待处置退货条数（PENDING_REVIEW，队列深度，不按期筛选） */
  pendingReturnDisposition: number
}

export async function getLossKPIs(days: number): Promise<LossKPIs> {
  const { start, end } = periodRange(days)
  const [scrapValue, disposition, pendingCount] = await Promise.all([
    getScrapValueSum(start, end),
    getDispositionCounts(start, end),
    getPendingReturnCount(),
  ])
  const denom = disposition.sellableQty + disposition.scrapQty
  const returnRecoveryRatePct = denom > 0
    ? Math.round((disposition.sellableQty / denom) * 1000) / 10
    : null
  return {
    scrapValueThisPeriod: round2(scrapValue),
    returnRecoveryRatePct,
    pendingReturnDisposition: pendingCount,
  }
}

export interface LossTrendWeek {
  weekLabel: string
  /** 全部来源的报废数量（仓库过期/损坏 + 客退报废） */
  scrapQty: number
  /** 其中来自客退报废的数量（StockMove.sourceType='RETURN_SCRAP' 子集） */
  returnScrapQty: number
}

export async function getLossTrend(weeks = 8): Promise<LossTrendWeek[]> {
  const thisWeekStart = mondayStart(new Date())
  const rangeStart = new Date(thisWeekStart)
  rangeStart.setDate(rangeStart.getDate() - (weeks - 1) * 7)

  const rows = await p.stockMove.findMany({
    where: { type: 'SCRAP', movedAt: { gte: rangeStart } },
    select: { movedAt: true, qty: true, sourceType: true },
  })

  const buckets = new Map<string, { scrapQty: number; returnScrapQty: number }>()
  for (const row of rows as Array<{ movedAt: Date; qty: unknown; sourceType: string | null }>) {
    const weekKey = toDayKey(mondayStart(new Date(row.movedAt)))
    const qty = Math.abs(toNum(row.qty))
    const bucket = buckets.get(weekKey) ?? { scrapQty: 0, returnScrapQty: 0 }
    bucket.scrapQty += qty
    if (row.sourceType === 'RETURN_SCRAP') bucket.returnScrapQty += qty
    buckets.set(weekKey, bucket)
  }

  const out: LossTrendWeek[] = []
  for (let i = 0; i < weeks; i++) {
    const ws = new Date(rangeStart)
    ws.setDate(ws.getDate() + i * 7)
    const bucket = buckets.get(toDayKey(ws))
    out.push({
      weekLabel: formatWeekLabel(ws),
      scrapQty: round2(bucket?.scrapQty ?? 0),
      returnScrapQty: round2(bucket?.returnScrapQty ?? 0),
    })
  }
  return out
}

export interface ReturnDispositionSplit {
  sellableQty: number
  scrapQty: number
  pendingQty: number
  sellablePct: number
  scrapPct: number
  pendingPct: number
}

export async function getReturnDispositionSplit(days: number): Promise<ReturnDispositionSplit> {
  const { start, end } = periodRange(days)
  const { sellableQty, scrapQty, pendingQty } = await getDispositionCounts(start, end)
  const total = sellableQty + scrapQty + pendingQty
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
  return {
    sellableQty: round2(sellableQty),
    scrapQty: round2(scrapQty),
    pendingQty: round2(pendingQty),
    sellablePct: pct(sellableQty),
    scrapPct: pct(scrapQty),
    pendingPct: pct(pendingQty),
  }
}

export interface LossReasonRow {
  reason: string
  reasonLabel: string
  qty: number
}

export async function getLossReasonBreakdown(days: number): Promise<LossReasonRow[]> {
  const { start, end } = periodRange(days)
  const rows = await p.stockMove.findMany({
    where: { type: 'SCRAP', movedAt: { gte: start, lt: end } },
    select: { qty: true, note: true, lossReason: true },
  })

  const byKey = new Map<string, number>()
  for (const row of rows as Array<{ qty: unknown; note: string | null; lossReason: string | null }>) {
    // 结构化字段优先（台账 E4 起写入）；老数据仍从 note 反解 —— 反解是**兜底**，
    // 不再是唯一来源：写入时改一句文案就静默把统计打散，那正是这次要终结的问题
    const key = row.lossReason ?? reasonKeyFromLabel(parseReasonLabel(row.note))
    byKey.set(key, (byKey.get(key) ?? 0) + Math.abs(toNum(row.qty)))
  }

  return Array.from(byKey.entries())
    .map(([reason, qty]) => ({ reason, reasonLabel: SCRAP_REASON_LABEL[reason] ?? reason, qty: round2(qty) }))
    .sort((a, b) => b.qty - a.qty)
}

/**
 * 按环节拆分（台账 E4 验收：「损耗看板按环节/原因能拆分」）。
 * 历史行没有 lossStage，按原因反推并单独计入 inferredQty —— 看板据此标注
 * 「其中 N 为按原因推断」，不把猜的和填的混成一个数。
 */
export async function getLossStageBreakdown(days: number): Promise<StageBreakdownRow[]> {
  const { start, end } = periodRange(days)
  const rows = await p.stockMove.findMany({
    where: { type: 'SCRAP', movedAt: { gte: start, lt: end } },
    select: { qty: true, note: true, lossStage: true, lossReason: true },
  }) as Array<{ qty: unknown; note: string | null; lossStage: string | null; lossReason: string | null }>

  return summarizeByStage(rows.map(r => ({
    qty: toNum(r.qty),
    lossStage: r.lossStage,
    lossReason: r.lossReason,
    fallbackReason: reasonKeyFromLabel(parseReasonLabel(r.note)),
  })))
}

export interface TopLossProduct {
  productId: string
  productName: string
  scrapQty: number
  scrapValue: number
}

export async function getTopLossProducts(days: number, limit: number): Promise<TopLossProduct[]> {
  const { start, end } = periodRange(days)
  const rows = (await p.$queryRawUnsafe(
    `SELECT sm."productId" AS product_id, MAX(sm."productName") AS product_name,
            SUM(ABS(sm.qty))::float AS qty,
            SUM(ABS(sm.qty) * COALESCE(l."unitCost", pr."standardPrice", 0))::float AS amount
     FROM "StockMove" sm
     LEFT JOIN "Lot" l ON l.id = sm."lotId"
     LEFT JOIN "Product" pr ON pr.id = sm."productId"
     WHERE sm."movedAt" >= $1 AND sm."movedAt" < $2 AND sm.type = 'SCRAP'
     GROUP BY sm."productId"
     ORDER BY SUM(ABS(sm.qty) * COALESCE(l."unitCost", pr."standardPrice", 0)) DESC
     LIMIT $3`,
    start, end, limit,
  )) as Array<{ product_id: string; product_name: string; qty: number; amount: number }>

  return rows.map(r => ({
    productId: r.product_id,
    productName: r.product_name,
    scrapQty: round2(r.qty),
    scrapValue: round2(r.amount),
  }))
}
