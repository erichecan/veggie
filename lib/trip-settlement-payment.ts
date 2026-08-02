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
}

const round2 = (n: number) => Math.round(n * 100) / 100

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
): AllocationResult {
  const byId = new Map(invoices.map(i => [i.id, { ...i }]))
  const payments: PaymentPlanItem[] = []
  const unallocated: AllocationResult['unallocated'] = []

  for (const stop of stops) {
    let remaining = round2(stop.amount)
    if (remaining <= 0) continue

    // 该站涉及的发票，去重
    const invoiceIds = [...new Set(stop.orderIds.flatMap(oid => orderToInvoices.get(oid) ?? []))]
    const candidates = invoiceIds
      .map(id => byId.get(id))
      .filter((i): i is InvoiceForAllocation => !!i)

    if (candidates.length === 0) {
      unallocated.push({
        restaurantName: stop.restaurantName,
        amount: remaining,
        reason: '该站订单没有对应发票，无法核销',
      })
      continue
    }

    const posted = candidates.filter(i => i.status === 'POSTED' && i.amountDue > 0)
    const draft = candidates.filter(i => i.status === 'DRAFT')

    if (posted.length === 0) {
      unallocated.push({
        restaurantName: stop.restaurantName,
        amount: remaining,
        reason: draft.length > 0
          // 过账是财务动作，不能作为交账确认的副作用悄悄做掉
          ? `关联发票尚未过账（${draft.map(d => d.name).join('、')}），请先过账再核销`
          : '关联发票已结清或已作废，无可核销金额',
      })
      continue
    }

    // 标准 AR 应用顺序：到期早的先还
    posted.sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0
      if (a.dueDate) return -1
      if (b.dueDate) return 1
      return 0
    })

    for (const inv of posted) {
      if (remaining <= 0) break
      const take = round2(Math.min(remaining, inv.amountDue))
      if (take <= 0) continue
      payments.push({
        invoiceId: inv.id,
        invoiceName: inv.name,
        customerId: inv.customerId,
        amount: take,
        restaurantName: stop.restaurantName,
      })
      inv.amountDue = round2(inv.amountDue - take)
      remaining = round2(remaining - take)
    }

    // 收的钱比欠的多——多半是预付或录错，不硬塞进发票，交给财务判断
    if (remaining > 0) {
      unallocated.push({
        restaurantName: stop.restaurantName,
        amount: remaining,
        reason: '实收金额超过该客户未结清发票总额，超收部分需人工确认（预付款或录入有误）',
      })
    }
  }

  return {
    payments,
    unallocated,
    totalAllocated: round2(payments.reduce((s, p) => s + p.amount, 0)),
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
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 把一趟行程各站的实收核销到发票上并写 Payment。
 * 幂等：同一 trip 重复确认不会重复记账。
 */
export async function postTripCollections(
  prisma: any,
  trip: { id: string; restaurants: unknown },
  actorUserId: string,
): Promise<SettlementPostingResult> {
  const marker = tripPaymentMarker(trip.id)

  const already = await prisma.payment.count({ where: { note: { contains: marker } } })
  if (already > 0) {
    return { created: 0, totalAllocated: 0, skippedAsDuplicate: true, unallocated: [], invoicesPaidOff: [] }
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
    return { created: 0, totalAllocated: 0, skippedAsDuplicate: false, unallocated: [], invoicesPaidOff: [] }
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

  const plan = allocateCollections(
    stops,
    invoiceRows.map((i: any) => ({
      id: i.id, name: i.name, customerId: i.customerId,
      amountDue: Number(i.amountDue ?? 0),
      status: String(i.status),
      dueDate: i.dueDate ? String(i.dueDate) : null,
    })),
    orderToInvoices,
  )

  const paidOff: string[] = []
  for (const p of plan.payments) {
    await prisma.$transaction(async (tx: any) => {
      await tx.payment.create({
        data: {
          invoiceId: p.invoiceId,
          customerId: p.customerId,
          amount: p.amount,
          method: 'cash',
          note: `司机交账核销 · ${p.restaurantName} · ${marker}`,
          createdBy: actorUserId,
        },
      })
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
  }
}
