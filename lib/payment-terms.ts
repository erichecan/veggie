/**
 * 账期口径唯一来源（20260826）
 * ============================================================================
 * 客户反馈账期太死板：只有现结/周结/月结三档，且逾期检查只覆盖月结客户，
 * 现结/周结客户完全不检查逾期——这本身是个漏洞。这里把账期扩到五档，
 * 统一给出每档对应的天数，供到期日推算与逾期判定共用同一份口径。
 *
 * 天数按固定自然日算（7/14/30/60），不按自然月对齐——如果客户是按每月
 * 固定几号出对账单，这个基准需要另外调整，目前没有这个诉求。
 */

export type PaymentTerm = 'cash' | 'weekly' | 'biweekly' | 'monthly' | 'bimonthly'

export interface PaymentTermOption {
  value: PaymentTerm
  days: number
  labelEn: string
  labelZh: string
}

export const PAYMENT_TERM_OPTIONS: PaymentTermOption[] = [
  { value: 'cash', days: 0, labelEn: 'Immediate Payment (Cash)', labelZh: '现结' },
  { value: 'weekly', days: 7, labelEn: 'Weekly', labelZh: '周结' },
  { value: 'biweekly', days: 14, labelEn: 'Biweekly (2 Weeks)', labelZh: '双周结' },
  { value: 'monthly', days: 30, labelEn: 'Monthly', labelZh: '月结' },
  { value: 'bimonthly', days: 60, labelEn: 'Bimonthly (2 Months)', labelZh: '双月结' },
]

const DAYS_BY_TERM: Record<string, number> = Object.fromEntries(
  PAYMENT_TERM_OPTIONS.map(o => [o.value, o.days]),
)

/** 未知/历史脏值（如 Odoo 遗留的 NET30/IMMEDIATE）一律按"不检查逾期"处理，不猜天数 */
export function isKnownPaymentTerm(term: string | null | undefined): term is PaymentTerm {
  return !!term && term in DAYS_BY_TERM
}

/** 账期天数；未知账期返回 null（调用方应视为"不参与逾期判定"，不要默认成某个天数） */
export function termDays(term: string | null | undefined): number | null {
  if (!isKnownPaymentTerm(term)) return null
  return DAYS_BY_TERM[term]
}

/** 从开票日按账期天数推算到期日；账期未知或 cash(0天) 时到期日就是开票日当天 */
export function computeDueDate(invoiceDate: Date, term: string | null | undefined): Date {
  const days = termDays(term) ?? 0
  return new Date(invoiceDate.getTime() + days * 86_400_000)
}

/**
 * 纸质单据上的付款方式文案（20260920）
 * ============================================================================
 * 之前销售单只认 cash/weekly/monthly 三档，其余一律印成「—」。实际生产库里
 * 还有 Odoo 遗留的 `COD`(37 家) / `30 Net Days` / `15 Days`，其中 COD 是货到付款——
 * 恰恰是最该提醒司机当场收钱的那类，却什么都不印。
 *
 * 处理原则：
 * - 认识的值按中英文字典印；
 * - 不认识但非空的值**原样印出**（`COD`、`30 Net Days` 这些对一线仍然是有效信息，
 *   印出来比印空白有用），不要因为「不在枚举里」就丢掉；
 * - `immediate` 用来决定是否红色高亮：现结与货到付款都要当场收款。
 */
export function paymentTermPrintLabel(
  term: string | null | undefined,
  lang: 'zh' | 'en' = 'en',
): { label: string; immediate: boolean } {
  const raw = (term ?? '').trim()
  if (!raw) return { label: '', immediate: false }

  const known = PAYMENT_TERM_OPTIONS.find(o => o.value === raw)
  if (known) {
    return {
      label: lang === 'zh' ? known.labelZh : known.labelEn,
      immediate: known.value === 'cash',
    }
  }

  // Odoo 遗留值：COD 需要当场收款，其余原样印出
  const isCod = /^cod$/i.test(raw) || /cash on delivery/i.test(raw)
  return {
    label: isCod ? (lang === 'zh' ? '货到付款 COD' : 'Cash on Delivery') : raw,
    immediate: isCod,
  }
}

/**
 * 导入用：把表格里的账期文字认成标准代码（20261007）。
 * 认代码(monthly)、详情页下拉的中英文名(Monthly / 月结 / Biweekly (2 Weeks))，
 * 以及导出文件里写的简称(Cash / 现付)——保证「导出 → 改 → 再导入」原样认得回来。
 * 认不出返回 undefined，由调用方给提示，不猜。
 */
const TERM_ALIASES: Record<string, PaymentTerm> = (() => {
  const m: Record<string, PaymentTerm> = {}
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  for (const o of PAYMENT_TERM_OPTIONS) {
    m[norm(o.value)] = o.value
    m[norm(o.labelEn)] = o.value
    m[norm(o.labelZh)] = o.value
  }
  Object.assign(m, { cash: 'cash', '现付': 'cash', '现金': 'cash', immediate: 'cash', '2 weeks': 'biweekly', '2 months': 'bimonthly' })
  return m
})()

export function parsePaymentTermInput(raw: string | null | undefined): PaymentTerm | undefined {
  if (!raw) return undefined
  return TERM_ALIASES[raw.trim().toLowerCase().replace(/\s+/g, ' ')]
}
