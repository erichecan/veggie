/**
 * 利润表（毛利口径）— 纯计算部分
 * ============================================================================
 * 口径：按 Account.type 通用聚合，不写死科目 code。
 *   营收 = Σ(credit − debit)，INCOME 类科目（当前只有 4000 Sales Revenue）
 *   COGS = Σ(debit − credit)，EXPENSE 类科目（当前只有 5000 Purchases/COGS；
 *          6000 Operating Expenses 科目已建但从未被任何过账函数使用）
 *   毛利 = 营收 − COGS
 *
 * ⚠️ 这不是净利润 —— 运营费用（工资/房租/物流）目前没有录入入口和过账逻辑，
 * 页面必须明确标注这一点，不能让人误以为是净利润。按 Account.type 通用查询
 * 而不是写死 4000/5000，是为了运营费用真正启用记账的那天，这里不用改代码
 * 就自动把它算进去。
 *
 * ⚠️ 已知现状（20260902 实测）：开发库 JournalEntry/JournalEntryLine 均为 0 行——
 * 过账函数（postInvoiceToJournal/postVendorBillToJournal）已经接进
 * /api/invoices/[id]/post 和 /api/vendor-bills/[id]，但还没有任何发票/账单真正
 * 走过这个流程。上线后如果数字全是 0，不代表功能坏了，是"还没有过账记录"，
 * 页面需要用类似 ap-aging 的提示条把这个原因讲清楚，不能让人以为是 bug。
 */

export interface JournalLineForIncomeStatement {
  accountType: 'INCOME' | 'EXPENSE'
  debit: number
  credit: number
}

export interface IncomeStatementResult {
  revenue: number
  cogs: number
  grossMargin: number
  grossMarginPct: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function computeIncomeStatement(
  rows: readonly JournalLineForIncomeStatement[],
): IncomeStatementResult {
  let revenue = 0
  let cogs = 0
  for (const r of rows) {
    if (r.accountType === 'INCOME') revenue += r.credit - r.debit
    else if (r.accountType === 'EXPENSE') cogs += r.debit - r.credit
  }
  revenue = round2(revenue)
  cogs = round2(cogs)
  const grossMargin = round2(revenue - cogs)
  const grossMarginPct = revenue > 0 ? round2((grossMargin / revenue) * 100) : 0
  return { revenue, cogs, grossMargin, grossMarginPct }
}
