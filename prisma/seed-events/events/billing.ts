/**
 * 应收链事件：开票(+记账) → 收款核销(+记账) → 对账单
 * ============================================================================
 * 提速策略（与真实批量接口同理）：
 *   - 科目预取一次 + 凭证号内存自增（不再每张票查 3 科目 + count()）
 *   - 回写 invoicedQty 用 ANY($1) 整组一条 SQL
 *   - 每个发票组的所有写操作用 $transaction([...]) 合并为一次往返
 * 记账逻辑等价 lib/accounting（发票：Dr 应收/Cr 收入+销项；收款：Dr 银行/Cr 应收，
 * 填补 app 未实现的收款记账）。
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '../../../lib/generated/prisma/client'
import { MARK, round2, DAY, type Ctx } from '../shared'
import type { MadeOrder } from './sales'

const ym = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

function addMap(m: Map<string, number>, key: string, v: number): void {
  m.set(key, round2((m.get(key) ?? 0) + v))
}

export async function runBilling(ctx: Ctx, completed: MadeOrder[]): Promise<void> {
  // 科目预取一次
  const accRows = await ctx.prisma.account.findMany({
    where: { code: { in: ['1100', '4000', '2200', '1200'] } },
    select: { id: true, code: true },
  })
  const acc: Record<string, string | undefined> = {}
  for (const a of accRows) acc[a.code] = a.id
  // 凭证号内存自增（接续已有，避免唯一冲突）
  let jeSeq = await ctx.prisma.journalEntry.count()
  const nextJE = (): string => `JE-${String(++jeSeq).padStart(5, '0')}`

  const salesByPM = new Map<string, number>()
  const payByPM = new Map<string, number>()

  // 按 (客户, 结算周期) 分组
  const groups = new Map<string, MadeOrder[]>()
  for (const o of completed) {
    const term = o.persona.paymentTerm
    let periodKey: string
    if (term === 'cash') periodKey = `cash|${o.id}`
    else if (term === 'weekly') periodKey = `wk|${Math.floor(o.date.getTime() / (7 * DAY))}`
    else periodKey = `mo|${ym(o.date)}`
    const key = `${o.persona.id}|${periodKey}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  for (const group of groups.values()) {
    const persona = group[0].persona
    const exTax = round2(group.reduce((a, o) => a + o.total, 0))
    let tax = 0
    for (const o of group) for (const s of o.specs) tax += s.product.sellPrice * s.qty * s.product.taxRate / 100
    tax = round2(tax)
    const incTax = round2(exTax + tax)
    const lastDate = group.reduce((a, o) => (o.date > a ? o.date : a), group[0].date)
    const invDate = new Date(lastDate.getTime() + DAY)
    const name = ctx.inv.next(MARK.invPrefix)
    const invId = randomUUID()
    const ids = group.map((o) => o.id)

    // 收款计划（与结算方式相关）
    let payPlan: Array<{ amount: number; date: Date }> = []
    if (persona.paymentTerm === 'cash') {
      payPlan = [{ amount: incTax, date: invDate }]
    } else if (persona.paymentTerm === 'weekly') {
      const payDate = new Date(invDate.getTime() + 7 * DAY)
      if (payDate <= ctx.now) {
        payPlan = ctx.rng.chance(0.8)
          ? [{ amount: incTax, date: payDate }]
          : [{ amount: round2(incTax * 0.6), date: payDate }]
      }
    } else {
      const payDate = new Date(invDate.getTime() + 30 * DAY)
      const r = ctx.rng.float()
      if (payDate <= ctx.now && r < 0.5) payPlan = [{ amount: incTax, date: payDate }]
      else if (r < 0.8) payPlan = [{ amount: round2(incTax * ctx.rng.money(0.3, 0.7)), date: payDate <= ctx.now ? payDate : ctx.now }]
    }
    let paid = round2(payPlan.reduce((a, p) => a + p.amount, 0))
    if (paid > incTax) paid = incTax
    const due = round2(incTax - paid)
    const fullyPaid = due <= 0.001

    // 整组写操作打包成一次往返
    const ops: Prisma.PrismaPromise<unknown>[] = []
    ops.push(
      ctx.prisma.invoice.create({
        data: {
          id: invId,
          name,
          customerId: persona.id,
          customerName: persona.name,
          saleOrderIds: ids,
          lines: group.map((o) => ({ orderId: o.id, orderCode: o.code, amount: o.total })),
          subtotalExTax: exTax,
          totalTax: tax,
          totalIncTax: incTax,
          amountPaid: paid,
          amountDue: due,
          status: fullyPaid ? 'PAID' : 'POSTED',
          paymentTerms: persona.paymentTerm,
          dueDate: isoDate(new Date(invDate.getTime() + (persona.paymentTerm === 'monthly' ? 30 : persona.paymentTerm === 'weekly' ? 7 : 0) * DAY)),
          postedAt: isoDate(invDate),
          paidAt: fullyPaid && payPlan.length > 0 ? isoDate(payPlan[payPlan.length - 1].date) : null,
          createdAt: invDate,
        },
      }),
    )
    // 发票凭证：Dr 应收 / Cr 收入 + 销项税
    if (acc['1100'] && acc['4000']) {
      const jeLines: Array<{ accountId: string; description: string; debit: number; credit: number; partnerId?: string; sequence: number }> = [
        { accountId: acc['1100'], description: `AR - ${name}`, debit: incTax, credit: 0, partnerId: persona.id, sequence: 10 },
        { accountId: acc['4000'], description: `Sales - ${name}`, debit: 0, credit: exTax, sequence: 20 },
      ]
      if (tax > 0 && acc['2200']) jeLines.push({ accountId: acc['2200'], description: `VAT Output - ${name}`, debit: 0, credit: tax, sequence: 30 })
      ops.push(
        ctx.prisma.journalEntry.create({
          data: {
            name: nextJE(),
            date: invDate,
            narration: `Invoice ${name} posted`,
            sourceType: 'invoice',
            sourceId: invId,
            status: 'POSTED',
            totalDebit: incTax,
            totalCredit: incTax,
            createdBy: ctx.financeId,
            postedAt: invDate,
            lines: { create: jeLines },
          },
        }),
      )
    }
    // 订单 LOCKED + invoicedQty 整组回写
    ops.push(ctx.prisma.order.updateMany({ where: { id: { in: ids } }, data: { status: 'LOCKED', lockedAt: invDate, invoiceDate: invDate } }))
    ops.push(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE "OrderLine" SET "invoicedQty" = "deliveredQty" WHERE "orderId" = ANY($1::text[])`,
        ids,),
    )
    // 收款 + 收款凭证
    for (const pp of payPlan) {
      if (pp.amount <= 0) continue
      ops.push(
        ctx.prisma.payment.create({
          data: {
            id: randomUUID(),
            invoiceId: invId,
            customerId: persona.id,
            amount: pp.amount,
            method: persona.paymentTerm === 'cash' ? 'cash' : 'transfer',
            paidAt: pp.date,
            note: MARK.stockNote,
            createdBy: ctx.financeId,
          },
        }),
      )
      if (acc['1200'] && acc['1100']) {
        ops.push(
          ctx.prisma.journalEntry.create({
            data: {
              name: nextJE(),
              date: pp.date,
              narration: `Payment ${name} (${MARK.jeMarker})`,
              sourceType: 'payment',
              sourceId: invId,
              status: 'POSTED',
              totalDebit: pp.amount,
              totalCredit: pp.amount,
              createdBy: ctx.financeId,
              postedAt: pp.date,
              lines: {
                create: [
                  { accountId: acc['1200'], description: `Bank - ${name}`, debit: pp.amount, credit: 0, sequence: 10 },
                  { accountId: acc['1100'], description: `AR - ${name}`, debit: 0, credit: pp.amount, partnerId: persona.id, sequence: 20 },
                ],
              },
            },
          }),
        )
      }
      addMap(payByPM, `${persona.id}|${ym(pp.date)}`, pp.amount)
    }
    addMap(salesByPM, `${persona.id}|${ym(invDate)}`, incTax)

    await ctx.prisma.$transaction(ops)
  }

  await buildStatements(ctx, salesByPM, payByPM)
}

/** 对账单：按客户·月汇总（createMany 批量写），闭环 closing = opening + sales - payments */
async function buildStatements(
  ctx: Ctx,
  salesByPM: Map<string, number>,
  payByPM: Map<string, number>,
): Promise<void> {
  const personaIds = [...new Set([...salesByPM.keys(), ...payByPM.keys()].map((k) => k.split('|')[0]))]
  const rows: Array<{
    tenantId: string; customerId: string; customerName: string
    periodStart: Date; periodEnd: Date
    openingBalance: number; totalSales: number; totalPayments: number; closingBalance: number
    status: string; createdAt: Date
  }> = []
  for (const pid of personaIds) {
    const persona = ctx.personas.find((p) => p.id === pid)
    if (!persona) continue
    const months = new Set<string>()
    for (const k of salesByPM.keys()) if (k.startsWith(pid + '|')) months.add(k.split('|')[1])
    for (const k of payByPM.keys()) if (k.startsWith(pid + '|')) months.add(k.split('|')[1])
    let opening = 0
    for (const m of [...months].sort()) {
      const sales = salesByPM.get(`${pid}|${m}`) ?? 0
      const pays = payByPM.get(`${pid}|${m}`) ?? 0
      const closing = round2(opening + sales - pays)
      const [y, mo] = m.split('-').map(Number)
      rows.push({
        tenantId: MARK.tenant,
        customerId: pid,
        customerName: persona.name,
        periodStart: new Date(Date.UTC(y, mo - 1, 1)),
        periodEnd: new Date(Date.UTC(y, mo, 0)),
        openingBalance: opening,
        totalSales: sales,
        totalPayments: pays,
        closingBalance: closing,
        status: 'confirmed',
        createdAt: new Date(Date.UTC(y, mo, 0)),
      })
      opening = closing
    }
  }
  if (rows.length > 0) await ctx.prisma.statement.createMany({ data: rows })
}
