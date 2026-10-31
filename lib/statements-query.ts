/**
 * 对账单列表筛选口径 —— 列表 API(GET /api/statements) 与导出共用这一份。
 * 条件目前很简单，抽出来是为了让「导出与列表用同一个函数」这条约束成立，
 * 以后加筛选项只改这一处，不会漏掉导出那边。
 */
export function buildStatementsWhere(searchParams: URLSearchParams): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')
  const query = searchParams.get('q')?.trim()
  const periodStart = searchParams.get('periodStart')
  const periodEnd = searchParams.get('periodEnd')
  if (status) where.status = status
  if (customerId) where.customerId = customerId
  if (query) where.customerName = { contains: query, mode: 'insensitive' }
  if (periodStart || periodEnd) {
    const start = periodStart ? new Date(`${periodStart}T00:00:00.000Z`) : undefined
    const end = periodEnd ? new Date(`${periodEnd}T00:00:00.000Z`) : undefined
    where.AND = [
      ...(end ? [{ periodStart: { lte: end } }] : []),
      ...(start ? [{ periodEnd: { gte: start } }] : []),
    ]
  }
  return where
}
