/**
 * 司机每日回传（台账 C8）
 * ============================================================================
 * 需求：司机收车时提交当日的「收回现金 / 订单总额 / 退货数 / 换货数」，
 * 生成一条当日对账记录，同一天重复提交要防重，且数字与该司机当日行程明细对得上。
 *
 * ## 为什么四个数字不各存一份
 *
 * 它们**已经有真相了**：
 *   · 现金     → `Trip.cashCollected`（司机按行程交账时填的）
 *   · 订单总额 → `Trip.totalPayment`
 *   · 退货/换货 → `Trip.restaurants[].returns[]`，靠 `actionType` 区分（'exchange' 是换货）
 *
 * 再存一份就是第二处真相 —— C6 刚花一整轮把司机身份的分叉守住，这里不能立刻又开一个。
 * 所以日报表**只存提交那一刻的快照**，系统值一律由本模块实时派生，两者的差额单独给出。
 * 提交之后行程被改（退货审核通过、补录收款）是正常业务，差额正是对账要看见的东西。
 *
 * ## 「当日」怎么算
 *
 * 与波次同口径：取行程所属 `PickingWave.waveDate`，手工建的无波次行程退回
 * `Trip.createdAt` 的业务日。两处口径不同的话，同一趟车会在日报里消失或重复
 * （物流分析与提成报表已经踩过这个对齐问题）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface DailyDerived {
  /** 当日该司机的行程 id */
  tripIds: string[]
  /** 系统记录的现金合计（司机逐趟交账时填的） */
  cashCollected: number
  /** 系统记录的在线收款合计 */
  onlineCollected: number
  /** 应收货款合计 */
  orderTotal: number
  /** 退货笔数（actionType 不是 exchange 的） */
  returnCount: number
  /** 换货笔数 */
  exchangeCount: number
  /** 送达站点数，用于让司机确认"今天是不是就这些" */
  stopCount: number
  /** 还没提交交账的行程数 —— 有这些说明当日数据还不完整 */
  unsettledTripCount: number
}

interface ReturnLike { actionType?: string | null }
interface RestaurantLike { orderIds?: string[]; returns?: ReturnLike[]; delivered?: boolean }

/** 折叠所需的行程字段。单日与区间两条查询选的就是这几列（`TRIP_COLUMNS`）。 */
export interface TripRow {
  id: string
  cashCollected: unknown
  onlineCollected: unknown
  totalPayment: unknown
  settlementStatus: string | null
  restaurants: unknown
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 行程的业务日：优先波次日期，无波次退回创建日 —— 与 `/api/analytics/logistics` 同口径。
 * 单日与区间两条查询共用这一个表达式，否则同一趟车会在两张表里落到不同的天。
 */
const BIZDATE_EXPR = `COALESCE(w."waveDate", t."createdAt"::date)`
const TRIP_COLUMNS =
  `t.id, t."cashCollected", t."onlineCollected", t."totalPayment", t."settlementStatus", t.restaurants`
const TRIP_FROM = `FROM "Trip" t LEFT JOIN "PickingWave" w ON w.id = t."waveId"`

/**
 * 把若干行程折叠成一天的四项数字。**纯函数**，单日版与区间版（C10 对账表）
 * 都必须经由它 —— 各写一遍聚合的话，司机看到的日报与财务看到的对账表会各算各的，
 * 而那种分叉从来不报错（司机 slot、税率量纲都是这么栽的）。
 */
export function foldTrips(trips: TripRow[]): DailyDerived {
  let cash = 0, online = 0, orderTotal = 0
  let returnCount = 0, exchangeCount = 0, stopCount = 0, unsettled = 0

  for (const t of trips) {
    cash += num(t.cashCollected)
    online += num(t.onlineCollected)
    orderTotal += num(t.totalPayment)
    if (t.settlementStatus === 'pending' || t.settlementStatus == null) unsettled++

    const rests = (Array.isArray(t.restaurants) ? t.restaurants : []) as RestaurantLike[]
    for (const r of rests) {
      if (r.delivered) stopCount++
      for (const ret of r.returns ?? []) {
        if (ret.actionType === 'exchange') exchangeCount++
        else returnCount++
      }
    }
  }

  return {
    tripIds: trips.map(t => t.id),
    cashCollected: round2(cash),
    onlineCollected: round2(online),
    orderTotal: round2(orderTotal),
    returnCount,
    exchangeCount,
    stopCount,
    unsettledTripCount: unsettled,
  }
}

/**
 * 按 `YYYY-MM-DD` 的业务日，派生某司机当天的四项数字。
 *
 * 退货与换货数的是**笔数**而不是件数：司机收车时点的是「今天退了几单东西」，
 * 让他去累加数量既不现实也对不上（同一单可能退 3 个品项）。
 */
export async function deriveDailyReport(
  prisma: Db,
  driverId: string,
  dateStr: string,
): Promise<DailyDerived> {
  // ⛔ 这里**按 date 直接相等**比，不用 [start, end) 的 timestamp 区间。
  // 实测原因：把 JS Date 交给 $queryRawUnsafe 与 date 列比较时，参数会被序列化成
  // date，于是上界 `bizdate < end` 变成 `2026-06-29 < 2026-06-29` —— 恒假，
  // **当天被整个排除**，派生值全是 0。区间跨多天时这个误差看不出来
  // （只丢最后一天），单日查询直接归零。
  const trips = await prisma.$queryRawUnsafe(
    `SELECT ${TRIP_COLUMNS}
     ${TRIP_FROM}
     WHERE t."driverId" = $1
       AND t.status <> 'PENDING'
       AND ${BIZDATE_EXPR} = $2::date`,
    driverId, dateStr,
  ) as TripRow[]

  return foldTrips(trips)
}

/** `${driverId}|${YYYY-MM-DD}` —— 区间派生结果的键，与对账表的行键同一套 */
export function derivedKey(driverId: string, dateStr: string): string {
  return `${driverId}|${dateStr}`
}

/**
 * 区间派生（C10 对账表）：一次查询覆盖 [from, to] 全部司机 × 全部业务日。
 *
 * ⛔ **不能循环调 `deriveDailyReport`** —— 30 天 × 10 个司机就是 300 次查询，
 * 正是验证清单点名的 N+1。这里一次取回，在 JS 里按 `(driverId, 业务日)` 分组，
 * 每组交给同一个 `foldTrips`。
 *
 * 日期一路走字符串（`to_char` 出、`::date` 入），**不经过 JS `Date`** ——
 * 业务日是 date 列，转成 `Date` 再转回来正是 C8 那个「当天被整个排除」的来源。
 */
export async function deriveDailyReportRange(
  prisma: Db,
  opts: { from: string; to: string; driverIds?: string[] },
): Promise<Map<string, DailyDerived>> {
  const filterByDriver = opts.driverIds && opts.driverIds.length > 0
  const rows = await prisma.$queryRawUnsafe(
    `SELECT t."driverId",
            to_char(${BIZDATE_EXPR}, 'YYYY-MM-DD') AS bizdate,
            ${TRIP_COLUMNS}
     ${TRIP_FROM}
     WHERE t.status <> 'PENDING'
       AND t."driverId" IS NOT NULL
       AND ${BIZDATE_EXPR} BETWEEN $1::date AND $2::date
       ${filterByDriver ? `AND t."driverId" = ANY($3::text[])` : ''}`,
    ...(filterByDriver
      ? [opts.from, opts.to, opts.driverIds]
      : [opts.from, opts.to]),
  ) as Array<TripRow & { driverId: string; bizdate: string }>

  const grouped = new Map<string, TripRow[]>()
  for (const r of rows) {
    const key = derivedKey(r.driverId, r.bizdate)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(r)
    else grouped.set(key, [r])
  }

  const out = new Map<string, DailyDerived>()
  for (const [key, trips] of grouped) out.set(key, foldTrips(trips))
  return out
}

export interface ReportDiff {
  field: 'cashCollected' | 'orderTotal' | 'returnCount' | 'exchangeCount'
  label: string
  declared: number
  system: number
  diff: number
}

/**
 * 申报值 vs 系统值。**只列出对不上的**，全对上时返回空数组。
 *
 * 金额留 1 分钱容差（浮点累加），笔数必须精确相等 —— 差一笔就是漏报或多报。
 */
export function diffReport(
  declared: { cashCollected: number; orderTotal: number; returnCount: number; exchangeCount: number },
  system: DailyDerived,
): ReportDiff[] {
  const out: ReportDiff[] = []
  const money: Array<[ReportDiff['field'], string, number, number]> = [
    ['cashCollected', '收回现金', declared.cashCollected, system.cashCollected],
    ['orderTotal', '订单总额', declared.orderTotal, system.orderTotal],
  ]
  for (const [field, label, d, s] of money) {
    if (Math.abs(d - s) > 0.01) out.push({ field, label, declared: d, system: s, diff: round2(d - s) })
  }
  const counts: Array<[ReportDiff['field'], string, number, number]> = [
    ['returnCount', '退货笔数', declared.returnCount, system.returnCount],
    ['exchangeCount', '换货笔数', declared.exchangeCount, system.exchangeCount],
  ]
  for (const [field, label, d, s] of counts) {
    if (d !== s) out.push({ field, label, declared: d, system: s, diff: d - s })
  }
  return out
}

/** 业务日字符串校验：只接受 YYYY-MM-DD，且必须是真实存在的日期 */
export function parseReportDate(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  // 2026-02-31 这种会被 Date 悄悄滚到 3 月，回写一遍比对才能挡住
  return d.toISOString().slice(0, 10) === v ? v : null
}
