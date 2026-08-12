/**
 * 报表下钻（台账 H2）
 * ============================================================================
 * 验收要「行列互换与下钻可用」。互换已有（ReportingToolbar 的 FLIP_AXES），
 * 缺的是下钻 —— 点某一行展开它的下一级明细。
 *
 * 下钻**不新开接口**：它就是「原查询 + 多一个分组维度 + 一个把范围锁死在这一行的筛选」。
 * 这一层只负责把那个子请求算出来，因此可以在没有数据库的情况下逐条钉死语义。
 *
 * 为什么需要一个函数而不是就地拼：日期维度的行值是 `DATE_TRUNC` 之后的结果
 * （行 key 叫 `order_date_month`、值是当月 1 号），拿它去等值筛选原始
 * `order_date` 一条都匹配不上 —— 必须还原成 [月初, 下月初) 的区间。
 * 这个换算写错不会报错，只会让下钻结果恒为空，而空表看起来很像「本来就没数据」。
 */

import type { DateInterval, DimensionSpec, FilterSpec, ReportRequest } from './types'

/** 行对象里，某个维度对应的列名（日期维度带 interval 后缀，与 sql-builder 的别名一致） */
export function rowFieldAlias(dim: DimensionSpec): string {
  return dim.interval ? `${dim.field}_${dim.interval}` : dim.field
}

/** 取 UTC 日期的 YYYY-MM-DD —— 视图里 DATE_TRUNC 的结果按 UTC 存，别用本地时区格式化 */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * 把「某个时间桶的值」还原成 [起, 止) 区间。
 * 传入的是该桶的起点（DATE_TRUNC 的结果），返回的止是**下一个桶的起点**。
 */
export function intervalRange(value: string | Date, interval: DateInterval): [string, string] {
  const start = new Date(value)
  if (isNaN(start.getTime())) throw new Error(`无法解析时间桶取值：${String(value)}`)
  const end = new Date(start)
  switch (interval) {
    case 'day': end.setUTCDate(end.getUTCDate() + 1); break
    case 'week': end.setUTCDate(end.getUTCDate() + 7); break
    case 'month': end.setUTCMonth(end.getUTCMonth() + 1); break
    case 'quarter': end.setUTCMonth(end.getUTCMonth() + 3); break
    case 'year': end.setUTCFullYear(end.getUTCFullYear() + 1); break
  }
  return [ymd(start), ymd(end)]
}

/**
 * 把「这一行」锁死成筛选条件。时间桶还原成区间；其余维度按等值。
 *
 * ⛔ 时间桶**必须用 `>=` + `<` 两条，不能用 `between`**：
 * sql-builder 里 between 生成的是 `BETWEEN a AND b`（两端都闭），而这些列是 timestamp。
 * 拿日期串当上界，`2026-08-31` 会被读成当天 00:00:00，于是 8-31 全天的记录一条都不进来 ——
 * 下钻的子行合计会比父行少一整天，而两个数字都"看起来挺合理"。
 * （G1 的对账单期间栽的就是同一个坑，这里不再犯第二次。）
 *
 * ⚠️ 值为空（NULL/空串）的行**返回 null**，调用方据此禁用下钻：
 * 用 `= ''` 去筛 NULL 在 SQL 里永远不成立，点了会得到一张空表，
 * 而用户会以为「这一行下面真的没东西」。宁可不给点，也不要给个假答案。
 */
export function rowFilterFor(dim: DimensionSpec, row: Record<string, unknown>): FilterSpec[] | null {
  const raw = row[rowFieldAlias(dim)]
  if (raw === null || raw === undefined || raw === '') return null

  if (dim.interval) {
    const [from, to] = intervalRange(raw as string | Date, dim.interval)
    return [
      { field: dim.field, operator: '>=', value: from },
      { field: dim.field, operator: '<', value: to },
    ]
  }
  return [{ field: dim.field, operator: '=', value: String(raw) }]
}

export interface DrillInput {
  /** 当前报表请求（下钻在它的基础上加东西，不改它） */
  base: Pick<ReportRequest, 'rowDimensions' | 'colDimensions' | 'measures' | 'filters'>
  /** 被点开的那一行 */
  row: Record<string, unknown>
  /** 展开成哪个维度 */
  by: DimensionSpec
}

/**
 * 构造下钻子请求。
 *
 * 语义：把当前**所有行维度**都锁成该行的取值，再按 `by` 分一次组。
 * 于是「子行合计 == 父行」这条恒等式天然成立 —— 它也正是端到端脚本里断言的那条。
 */
export function buildDrillRequest({ base, row, by }: DrillInput): ReportRequest | null {
  const lockFilters: FilterSpec[] = []
  for (const dim of base.rowDimensions) {
    const f = rowFilterFor(dim, row)
    if (!f) return null      // 有一个维度锁不住，整个下钻就是不可信的
    lockFilters.push(...f)
  }
  return {
    rowDimensions: [by],
    // 列维度原样带上：父行在交叉表里是按列拆开的，子行不带列维度就没法与父行逐格对照
    colDimensions: base.colDimensions ?? [],
    measures: base.measures,
    filters: [...(base.filters ?? []), ...lockFilters],
    limit: 200,
  }
}

/**
 * 可作为下钻目标的维度：排除已经在行/列上用过的（再展开一次只会得到一模一样的一行），
 * 也排除被点那一行自身的维度。
 */
export function drillCandidates<T extends { field: string }>(
  allDims: T[],
  used: DimensionSpec[],
): T[] {
  const usedFields = new Set(used.map(d => d.field))
  return allDims.filter(d => !usedFields.has(d.field))
}

/** 行的稳定标识：用于记住哪些行被展开了（行顺序会因排序变化，不能用下标） */
export function rowKeyOf(dims: DimensionSpec[], row: Record<string, unknown>): string {
  return dims.map(d => `${d.field}=${String(row[rowFieldAlias(d)] ?? '')}`).join('|')
}
