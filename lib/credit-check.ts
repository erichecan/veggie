/**
 * 客户信用/账期管控——唯一口径（20260826）
 * ============================================================================
 * 这套校验此前在 `app/api/customers/[id]/credit/route.ts`（展示用）和
 * `app/api/orders/route.ts`（下单拦截）各写了一份，两处逐字重复，且都只在
 * `paymentTerm === 'monthly'` 时检查逾期——现结/周结/双周结/双月结客户逾期了
 * 系统完全不拦，这本身是个漏洞。这里统一成一个函数：
 *   - 逾期判定覆盖所有账期类型（cash 除外，cash 本来就不赊账）
 *   - 接入账期临时延期（`Customer.termExtendedUntil`）：延期窗口内两类拦截
 *     （逾期 + 信用额度超限）都不生效，但欠款/逾期金额仍如实返回，不隐藏
 */
import type { prisma as PrismaSingleton } from './db'
import { isKnownPaymentTerm } from './payment-terms'
import { toNum } from './decimal-helpers'

type PrismaLike = typeof PrismaSingleton

export interface CreditCheckInput {
  customerId: string
  paymentTerm: string | null
  /** 接受 Prisma Decimal / number / string，内部统一用 toNum() 转换 */
  creditLimit: unknown
  termExtendedUntil: Date | string | null
}

export interface CreditCheckResult {
  outstandingBalance: number
  overdueAmount: number
  creditLimit: number
  isTermExtended: boolean
  termExtendedUntil: string | null
  /** 是否被逾期或信用额度拦截（未计入延期豁免与角色特批） */
  blocked: boolean
  blockReason?: string
}

export async function checkCustomerCredit(prisma: PrismaLike, input: CreditCheckInput): Promise<CreditCheckResult> {
  const { customerId, paymentTerm, termExtendedUntil } = input
  const creditLimit = toNum(input.creditLimit)

  const today = new Date().toISOString().slice(0, 10)
  const isTermExtended = !!termExtendedUntil && new Date(termExtendedUntil).toISOString().slice(0, 10) >= today

  // cash 客户本来就不赊账，不查发票、不拦
  if (paymentTerm === 'cash') {
    return {
      outstandingBalance: 0,
      overdueAmount: 0,
      creditLimit,
      isTermExtended,
      termExtendedUntil: termExtendedUntil ? new Date(termExtendedUntil).toISOString() : null,
      blocked: false,
    }
  }

  const invoices = await prisma.invoice.findMany({
    where: { customerId, status: 'POSTED' },
    select: { amountDue: true, dueDate: true },
  })
  const outstandingBalance = invoices.reduce((s, inv) => s + Number(inv.amountDue), 0)
  const overdueAmount = invoices
    .filter(inv => inv.dueDate && inv.dueDate < today)
    .reduce((s, inv) => s + Number(inv.amountDue), 0)

  let blocked = false
  let blockReason: string | undefined
  if (creditLimit > 0 && outstandingBalance >= creditLimit) {
    blocked = true
    blockReason = `欠款 €${outstandingBalance.toFixed(2)} 已达信用额度上限 €${creditLimit.toFixed(2)}`
  } else if (overdueAmount > 0 && isKnownPaymentTerm(paymentTerm)) {
    // 只对识别得出账期天数的客户判定逾期——未知/历史脏值(如 Odoo 遗留的 NET30)
    // 不去猜天数，维持"不拦"，跟改造前对这批客户的行为一致
    blocked = true
    blockReason = `有逾期欠款 €${overdueAmount.toFixed(2)}，账期已超`
  }

  if (blocked && isTermExtended) {
    blocked = false
    blockReason = undefined
  }

  return {
    outstandingBalance,
    overdueAmount,
    creditLimit,
    isTermExtended,
    termExtendedUntil: termExtendedUntil ? new Date(termExtendedUntil).toISOString() : null,
    blocked,
    blockReason,
  }
}
