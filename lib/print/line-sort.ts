/**
 * 打印行的统一排序：**按商品 sequence（商品页上那一列，Odoo 的目录/拣货顺序）**。
 * ============================================================================
 * 所有单据打印共用这一份，口径只有一处（2026-08-18 客户要求）。
 *
 * 为什么不能只写 `sort((a,b) => a.seq - b.seq)`，生产实测两个数字：
 *   - 132,847 张多行订单里 102,898 张（77.5%）的 `OrderLine.sequence` 所有行都相同。
 *     以前按它排等于没排，顺序由数据库返回顺序决定 —— 这就是客户看到"乱序"的根因。
 *   - 1,337,596 条订单行里 245,649 条（18.4%）拿不到商品 sequence。
 *     把 NULL 当 0 会让这批行全挤到最前面；不给次级键则它们彼此之间仍然随机。
 *
 * 所以规则是：**sequence 升序（没有的排最后）→ 商品名 A→Z**。
 * 商品名是人眼可预期的顺序，客户对着单子能说出"为什么它排这里"。
 *
 * 见 docs/20260818-print-sequence-and-density-tasks.md
 */

export interface SortableLine {
  productName?: string | null
  /** 商品的 sequence（ProductTemplate.sequence）。没有值时排在最后 */
  productSequence?: number | null
}

/** 没有 sequence 的一律排到最后，而不是当成 0 排到最前 */
function seqKey(line: SortableLine): number {
  const s = line.productSequence
  return typeof s === 'number' && Number.isFinite(s) ? s : Number.POSITIVE_INFINITY
}

/**
 * 通用比较器：给字段名不叫 productSequence/productName 的调用方用
 * （日报的行结构是 { sequence, productName } / { sequence, name }）。
 * 口径与打印一致：有序号的在前按升序，没有的排最后按名称。
 */
export function compareSequenceThenName(
  aSeq: number | null | undefined,
  aName: string | null | undefined,
  bSeq: number | null | undefined,
  bName: string | null | undefined,
): number {
  const sa = typeof aSeq === 'number' && Number.isFinite(aSeq) ? aSeq : Number.POSITIVE_INFINITY
  const sb = typeof bSeq === 'number' && Number.isFinite(bSeq) ? bSeq : Number.POSITIVE_INFINITY
  if (sa !== sb) return sa < sb ? -1 : 1
  return (aName ?? '').localeCompare(bName ?? '', 'en')
}

export function compareByProductSequence(a: SortableLine, b: SortableLine): number {
  // 用比较而不是相减：两边都没有 sequence 时相减得 NaN，
  // 一边没有时得 ±Infinity —— 这两种情况都会让"减法版"给出错误答案
  return compareSequenceThenName(a.productSequence, a.productName, b.productSequence, b.productName)
}

/** 返回排好序的新数组，不改传入的那份（调用方常把原数组用于别的统计） */
export function sortLinesBySequence<T extends SortableLine>(lines: readonly T[]): T[] {
  return [...lines].sort(compareByProductSequence)
}
