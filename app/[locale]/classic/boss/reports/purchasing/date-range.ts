/**
 * 采购分析（矩阵视图 + 明细表）共用的日期边界工具。
 * ============================================================================
 * order_date 是不带时区的 timestamp（非 @db.Date），直接对"截止日"用 `<=` 会丢失
 * 截止日当天的数据（详见 SupplierMonthMatrix.tsx 顶部历史注释）。两个视图都需要把
 * "含当日"的截止日转成排他上界（次日 00:00, `<`），之前各自拷了一份，20260922
 * code review 指出来后抽成这一个文件，别再让两份实现分叉。
 */

/** 'YYYY-MM-DD' 加一天，返回同格式字符串。按本地日历日算，不涉及业务时区换算 ——
 *  选择器里选的就是本地日历日。 */
export function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d + 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}
