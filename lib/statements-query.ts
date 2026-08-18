/**
 * 对账单列表筛选口径 —— 列表 API(GET /api/statements) 与导出共用这一份。
 * 条件目前很简单，抽出来是为了让「导出与列表用同一个函数」这条约束成立，
 * 以后加筛选项只改这一处，不会漏掉导出那边。
 */
export function buildStatementsWhere(searchParams: URLSearchParams): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')
  if (status) where.status = status
  if (customerId) where.customerId = customerId
  return where
}
