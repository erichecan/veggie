/**
 * 司机交账 → 收款记录（Payment）
 *
 * 审计发现的缺口（M03-07 / M08-03）：行程完成会自动回写发票草稿、订单状态、司机提成冻结，
 * 司机交账也有结构化流程（提交 cashCollected → 财务确认），但**财务确认只翻转
 * `Trip.settlementStatus`，不生成任何 Payment**。结果是生产库里 Invoice 148,285 张、
 * Payment 0 条——现金收了，账上看不出来，对账仍靠人工比纸。
 *
 * 这个模块把「财务确认交账」变成真正的入账动作。三条设计取舍：
 *
 * 1. **不自动过账发票**。行程完成自动建的是 DRAFT 发票，而过账（POSTED）是财务动作，
 *    不该是交账确认的副作用。所以只往 POSTED 发票上核销；遇到 DRAFT 的如实报告，
 *    让财务自己决定要不要先过账。
 * 2. **按到期日从早到晚核销**（标准 AR 应用顺序），不是平均分摊。
 * 3. **幂等**。确认动作可能因网络重试触发两次，靠 `Payment.note` 里的
 *    `TRIP:<tripId>` 标记去重，不会重复记两笔钱。
 */

export interface InvoiceForAllocation {
  id: string
  name: string
  customerId: string
  amountDue: number
  status: string
  /** 到期日，用于排序；null 排最后 */
  dueDate: string | null
}

export interface StopCollection {
  restaurantId: string
  restaurantName: string
  /** 该站实收货款 */
  amount: number
  /** 该站关联的订单 */
  orderIds: string[]
}

export interface PaymentPlanItem {
  invoiceId: string
  invoiceName: string
  customerId: string
  amount: number
  restaurantName: string
  /**
   * true = 这笔核销的**不是当日订单**，而是该客户的历史欠款（台账 C9）。
   * 需求原文：「若金额超出当日订单额，需能标记出超出部分是回收的历史欠款并冲抵」。
   * 必须标出来 —— 财务看到「今天收了 €500 但今天只送了 €300 的货」时，
   * 要能立刻分清是多收了钱还是收回了旧账，这两件事的后续处理完全不同。
   */
  isHistoricalDebt?: boolean
}

export interface AllocationResult {
  /** 要创建的收款记录 */
  payments: PaymentPlanItem[]
  /** 无法入账的部分，需要财务人工处理 */
  unallocated: Array<{
    restaurantName: string
    amount: number
    reason: string
  }>
  totalAllocated: number
  /** 其中属于历史欠款回收的金额（台账 C9），供财务分辨"多收"与"收回旧账" */
  historicalDebtRecovered: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 标准 AR 应用顺序：到期早的先还，没有到期日的排最后 */
function sortByDueDate(list: InvoiceForAllocation[]): void {
  list.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })
}

/** 把历史发票登记进共享副本表 —— 同一客户多个站时扣减才会累计而不是各扣各的 */
function registerShared(
  byId: Map<string, InvoiceForAllocation>,
  i: InvoiceForAllocation,
): InvoiceForAllocation {
  const copy = { ...i }
  byId.set(i.id, copy)
  return copy
}

/** 钱没分完时，把「为什么分不掉」说清楚 —— 财务据此决定是退钱还是补发票 */
function reasonFor(
  candidateCount: number,
  postedCount: number,
  draft: InvoiceForAllocation[],
  triedHistory: boolean,
): string {
  if (candidateCount === 0) {
    return triedHistory
      ? '该站订单没有对应发票，且该客户没有未结清的历史欠款可冲抵'
      : '该站订单没有对应发票，无法核销'
  }
  if (postedCount === 0 && draft.length > 0) {
    // 过账是财务动作，不能作为交账确认的副作用悄悄做掉
    return `关联发票尚未过账（${draft.map(d => d.name).join('、')}），请先过账再核销`
  }
  if (postedCount === 0) {
    // 当日发票已结清/已作废。走到这里说明历史欠款也没冲掉（或压根没有），
    // 所以这笔钱确实无处可去 —— 理由要说的是"当日那张的状态"，不是"超收"
    return triedHistory
      ? '关联发票已结清或已作废，且该客户没有未结清的历史欠款可冲抵'
      : '关联发票已结清或已作废，无可核销金额'
  }
  return triedHistory
    ? '实收金额超过该客户全部未结清发票（含历史欠款），超收部分需人工确认（预付款或录入有误）'
    : '实收金额超过该客户未结清发票总额，超收部分需人工确认（预付款或录入有误）'
}

/**
 * 把各站收到的钱分配到发票上。
 *
 * @param stops        各站实收（司机现场录的 payment）
 * @param invoices     这些站关联订单对应的发票
 * @param orderToInvoices 订单 → 发票 id 列表（一张发票可能合并多单）
 */
export function allocateCollections(
  stops: StopCollection[],
  invoices: InvoiceForAllocation[],
  orderToInvoices: Map<string, string[]>,
  /**
   * 该站客户的**其他**未结清发票（当日订单之外的历史欠款），按客户分组。
   * 不传则维持老行为：超收部分进 unallocated 等财务人工处理。
   */
  historicalByCustomer?: Map<string, InvoiceForAllocation[]>,
): AllocationResult {
  const byId = new Map(invoices.map(i => [i.id, { ...i }]))
  const payments: PaymentPlanItem[] = []
  const unallocated: AllocationResult['unallocated'] = []

  for (const stop of stops) {
    let remaining = round2(stop.amount)
    if (remaining <= 0) continue

    // 该站涉及的当日发票，去重
    const invoiceIds = [...new Set(stop.orderIds.flatMap(oid => orderToInvoices.get(oid) ?? []))]
    const candidates = invoiceIds
      .map(id => byId.get(id))
      .filter((i): i is InvoiceForAllocation => !!i)

    const posted = candidates.filter(i => i.status === 'POSTED' && i.amountDue > 0)
    const draft = candidates.filter(i => i.status === 'DRAFT')

    // ── 第一步：核销当日订单的发票，标准 AR 顺序（到期早的先还）──────────────
    sortByDueDate(posted)
    for (const invc of posted) {
      if (remaining <= 0) break
      const take = round2(Math.min(remaining, invc.amountDue))
      if (take <= 0) continue
      payments.push({
        invoiceId: invc.id, invoiceName: invc.name, customerId: invc.customerId,
        amount: take, restaurantName: stop.restaurantName,
      })
      invc.amountDue = round2(invc.amountDue - take)
      remaining = round2(remaining - take)
    }

    // ── 第二步：还有剩 → 冲抵该客户的历史欠款（台账 C9）─────────────────────
    // 需求原文：「若金额超出当日订单额，需能标记出超出部分是回收的历史欠款并冲抵」。
    // 司机去送今天的货、顺手把上周的欠款一起收回来，是最常见的一种情况。
    //
    // ⚠️ 这一步必须在「当日没有可核销发票」时也执行 —— 第一版把它写在
    // `posted.length === 0 → continue` 之后，于是「客户当天的货已付清/是月结、
    // 司机收的纯粹是旧账」这个最典型的场景反而一分钱都冲不掉（单测抓出来的）。
    //
    // 客户 id 取 `stop.restaurantId`（餐馆就是客户），不依赖当日有没有发票。
    if (remaining > 0 && historicalByCustomer) {
      const custId = stop.restaurantId || candidates[0]?.customerId || ''
      const history = (historicalByCustomer.get(custId) ?? [])
        // 用共享副本，同一客户在一趟里有多个站时才不会把同一张发票扣两次
        .map(i => byId.get(i.id) ?? registerShared(byId, i))
        .filter(i => i.status === 'POSTED' && i.amountDue > 0 && !invoiceIds.includes(i.id))
      sortByDueDate(history)

      for (const invc of history) {
        if (remaining <= 0) break
        const take = round2(Math.min(remaining, invc.amountDue))
        if (take <= 0) continue
        payments.push({
          invoiceId: invc.id, invoiceName: invc.name, customerId: invc.customerId,
          amount: take, restaurantName: stop.restaurantName,
          isHistoricalDebt: true,
        })
        invc.amountDue = round2(invc.amountDue - take)
        remaining = round2(remaining - take)
      }
    }

    // ── 第三步：还有剩 → 那才真的是预付或录错，交给财务判断 ─────────────────
    if (remaining > 0) {
      unallocated.push({
        restaurantName: stop.restaurantName,
        amount: remaining,
        reason: reasonFor(candidates.length, posted.length, draft, !!historicalByCustomer),
      })
    }
  }

  return {
    payments,
    unallocated,
    totalAllocated: round2(payments.reduce((s, p) => s + p.amount, 0)),
    historicalDebtRecovered: round2(
      payments.filter(p => p.isHistoricalDebt).reduce((s, p) => s + p.amount, 0),
    ),
  }
}

/** 幂等标记：写进 Payment.note，重复确认时据此跳过 */
export function tripPaymentMarker(tripId: string): string {
  return `TRIP:${tripId}`
}

// ── 落库 ────────────────────────────────────────────────────────────────────

export interface SettlementPostingResult {
  created: number
  totalAllocated: number
  skippedAsDuplicate: boolean
  unallocated: AllocationResult['unallocated']
  invoicesPaidOff: string[]
  /** 其中冲抵历史欠款的金额（台账 C9） */
  historicalDebtRecovered: number
  /** 冲抵了哪几张历史发票，供财务核对与留痕 */
  historicalDebtInvoices: Array<{ name: string; amount: number; customerName?: string }>
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 把一趟行程各站的实收核销到发票上并写 Payment。
 * 幂等：同一 trip 重复确认不会重复记账。
 */
export async function postTripCollections(
  prisma: any,
  trip: { id: string; restaurants: unknown },
  /** 经手人显示名 —— 写进 `Payment.createdBy`，与 /api/payments 手工登记同语义。
   *  ⛔ 别传 userId：那一列会直接显示在对账单明细的「经手」列上 */
  actorName: string,
): Promise<SettlementPostingResult> {
  const marker = tripPaymentMarker(trip.id)

  const already = await prisma.payment.count({ where: { note: { contains: marker } } })
  if (already > 0) {
    return {
      created: 0, totalAllocated: 0, skippedAsDuplicate: true, unallocated: [],
      invoicesPaidOff: [], historicalDebtRecovered: 0, historicalDebtInvoices: [],
    }
  }

  const rests = (Array.isArray(trip.restaurants) ? trip.restaurants : []) as Array<{
    restaurantId?: string; restaurantName?: string; payment?: number; orderIds?: string[]
  }>

  const stops: StopCollection[] = rests
    .filter(r => typeof r.payment === 'number' && r.payment > 0)
    .map(r => ({
      restaurantId: r.restaurantId ?? '',
      restaurantName: r.restaurantName ?? '(未知站点)',
      amount: Number(r.payment),
      orderIds: r.orderIds ?? [],
    }))

  if (stops.length === 0) {
    return {
      created: 0, totalAllocated: 0, skippedAsDuplicate: false, unallocated: [],
      invoicesPaidOff: [], historicalDebtRecovered: 0, historicalDebtInvoices: [],
    }
  }

  const allOrderIds = [...new Set(stops.flatMap(s => s.orderIds))]
  const invoiceRows = await prisma.invoice.findMany({
    where: { saleOrderIds: { hasSome: allOrderIds } },
    select: { id: true, name: true, customerId: true, amountDue: true, status: true, dueDate: true, saleOrderIds: true },
  })

  const orderToInvoices = new Map<string, string[]>()
  for (const inv of invoiceRows) {
    for (const oid of (inv.saleOrderIds ?? []) as string[]) {
      orderToInvoices.set(oid, [...(orderToInvoices.get(oid) ?? []), inv.id])
    }
  }

  const toAlloc = (i: any): InvoiceForAllocation => ({
    id: i.id, name: i.name, customerId: i.customerId,
    amountDue: Number(i.amountDue ?? 0),
    status: String(i.status),
    dueDate: i.dueDate ? String(i.dueDate) : null,
  })

  // 该客户的**历史欠款**：当日订单之外的其他未结清 POSTED 发票（台账 C9）。
  // 司机去送今天的货、顺手把上周的欠款收回来，是最常见的一种情况 ——
  // 老实现把它当异常丢给财务手工处理。
  const customerIds = [...new Set(invoiceRows.map((i: any) => i.customerId as string))]
  const todaysInvoiceIds = new Set(invoiceRows.map((i: any) => i.id as string))
  const historicalRows = customerIds.length > 0
    ? await prisma.invoice.findMany({
        where: {
          customerId: { in: customerIds },
          status: 'POSTED',
          amountDue: { gt: 0 },
          id: { notIn: [...todaysInvoiceIds] },
        },
        select: { id: true, name: true, customerId: true, amountDue: true, status: true, dueDate: true },
      })
    : []

  const historicalByCustomer = new Map<string, InvoiceForAllocation[]>()
  for (const row of historicalRows) {
    const inv = toAlloc(row)
    historicalByCustomer.set(inv.customerId, [...(historicalByCustomer.get(inv.customerId) ?? []), inv])
  }

  const plan = allocateCollections(
    stops,
    invoiceRows.map(toAlloc),
    orderToInvoices,
    historicalByCustomer,
  )

  const paidOff: string[] = []
  const historicalDebtInvoices: SettlementPostingResult['historicalDebtInvoices'] = []
  for (const p of plan.payments) {
    await prisma.$transaction(async (tx: any) => {
      await tx.payment.create({
        data: {
          invoiceId: p.invoiceId,
          customerId: p.customerId,
          amount: p.amount,
          method: 'cash',
          // ⛔ 历史欠款回收要**在备注里写明**：对账单明细的「经手/摘要」列直接显示这一行，
          // 财务翻账时必须一眼看出这笔钱不是今天送的货收的
          note: p.isHistoricalDebt
            ? `司机交账核销 · ${p.restaurantName} · 历史欠款回收（${p.invoiceName}） · ${marker}`
            : `司机交账核销 · ${p.restaurantName} · ${marker}`,
          createdBy: actorName,
        },
      })
      if (p.isHistoricalDebt) {
        historicalDebtInvoices.push({ name: p.invoiceName, amount: p.amount })
      }
      const inv = await tx.invoice.update({
        where: { id: p.invoiceId },
        data: {
          amountPaid: { increment: p.amount },
          amountDue: { decrement: p.amount },
        },
        select: { amountDue: true, name: true },
      })
      // 结清了就推进状态，别让已付清的单继续挂在应收账龄里
      if (Number(inv.amountDue) <= 0.004) {
        await tx.invoice.update({ where: { id: p.invoiceId }, data: { status: 'PAID', amountDue: 0 } })
        paidOff.push(inv.name)
      }
    })
  }

  return {
    created: plan.payments.length,
    totalAllocated: plan.totalAllocated,
    skippedAsDuplicate: false,
    unallocated: plan.unallocated,
    invoicesPaidOff: paidOff,
    historicalDebtRecovered: plan.historicalDebtRecovered,
    historicalDebtInvoices,
  }
}
