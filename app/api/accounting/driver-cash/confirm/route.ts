import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { businessDayRange, toDayKey } from '@/lib/analytics/metrics'
import { postCollections, driverCashConfirmationMarker } from '@/lib/trip-settlement-payment'
import { getDriverCashPostingData } from '@/lib/accounting/driver-cash'

/**
 * 会计对照纸质回单核实司机手机端报告的实际收款后确认——**真正入账**：
 * 按司机报告金额和方式生成 Payment，并核销到发票。订单应收只作差异参考。
 * 确认不可撤销；有未完成手机回单、草稿发票或超出可核销余额时拒绝入账。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const { driverName, businessDate: businessDateInput } = body as {
        driverName?: string
        businessDate?: string
      }
      if (!driverName || !businessDateInput) {
        return NextResponse.json({ error: '缺少 driverName 或 businessDate' }, { status: 400 })
      }

      const at = new Date(`${businessDateInput}T00:00:00`)
      if (isNaN(at.getTime())) {
        return NextResponse.json({ error: 'businessDate 格式无效' }, { status: 400 })
      }
      const { start } = businessDayRange(at)
      const businessDate = toDayKey(start)

      const existing = await prisma.driverCashConfirmation.findUnique({
        where: { driverName_businessDate: { driverName, businessDate } },
      })
      if (existing) {
        return NextResponse.json({ error: '这个司机这一天已经确认过了，不能重复确认' }, { status: 409 })
      }

      const report = await getDriverCashPostingData(driverName, businessDate)
      if (report.orderIds.length === 0) {
        return NextResponse.json({ error: `这个司机 ${businessDate} 没有待确认的已出车订单，没什么可确认的` }, { status: 400 })
      }
      if (report.unreportedOrderCount > 0) {
        return NextResponse.json({ error: `司机回单尚未完整：还有 ${report.unreportedOrderCount} 张订单没有填写实收金额/收款方式或未完成签收，请先补齐手机报告` }, { status: 409 })
      }

      const allCollections = report.cashTotal + report.transferTotal
      if (allCollections > 0) {
        const drafts = await prisma.invoice.findMany({ where: { saleOrderIds: { hasSome: report.orderIds }, status: 'DRAFT' }, select: { name: true } })
        if (drafts.length) return NextResponse.json({ error: `司机报告有实收，但关联发票仍是草稿（${drafts.map(row => row.name).join('、')}）。请先核对并过账发票，再确认收款，避免收款无法分配。` }, { status: 409 })

        // The posting routine deliberately leaves money unmatched when no posted AR exists.
        // Do not lock the day confirmation in that case; an accountant must resolve the
        // prepayment/overpayment explicitly first.
        const customerCollections = new Map<string, { name: string; amount: number; orderIds: string[] }>()
        for (const collection of report.collections) {
          const current = customerCollections.get(collection.restaurantId) ?? { name: collection.restaurantName, amount: 0, orderIds: [] as string[] }
          current.amount = round2(current.amount + collection.amount)
          current.orderIds = [...new Set([...current.orderIds, ...collection.orderIds])]
          customerCollections.set(collection.restaurantId, current)
        }
        for (const [customerId, collection] of customerCollections) {
          const currentIds = await prisma.invoice.findMany({ where: { saleOrderIds: { hasSome: collection.orderIds }, customerId, status: 'POSTED', amountDue: { gt: 0 } }, select: { id: true } })
          const currentIdSet = new Set(currentIds.map(row => row.id))
          const [current, history] = await Promise.all([
            prisma.invoice.aggregate({ where: { id: { in: [...currentIdSet] } }, _sum: { amountDue: true } }),
            prisma.invoice.aggregate({ where: { customerId, status: 'POSTED', amountDue: { gt: 0 }, id: { notIn: [...currentIdSet] } }, _sum: { amountDue: true } }),
          ])
          const available = Number(current._sum.amountDue ?? 0) + Number(history._sum.amountDue ?? 0)
          if (collection.amount > available + 0.005) return NextResponse.json({ error: `${collection.name} 报告实收 €${collection.amount.toFixed(2)}，超过当前可核销发票余额 €${available.toFixed(2)}。请先处理预收/超收，再确认司机交账。` }, { status: 409 })
        }
      }

      const actorName = user.name ?? user.email ?? user.userId
      const { confirmation, posting } = await prisma.$transaction(async tx => {
        const created = await tx.driverCashConfirmation.create({
          data: {
            driverName,
            businessDate,
            cashTotal: round2(report.cashTotal),
            transferTotal: round2(report.transferTotal),
            orderIds: report.orderIds,
            paymentIds: [],
            confirmedById: user.userId,
            confirmedByName: actorName,
          },
        })
        const marker = driverCashConfirmationMarker(created.id)
        const result = await postCollections(tx, { marker, restaurants: report.collections }, actorName, user.userId)
        if (result.paymentIds.length > 0) {
          await tx.driverCashConfirmation.update({ where: { id: created.id }, data: { paymentIds: result.paymentIds } })
        }
        return { confirmation: created, posting: result }
      }, { timeout: 60000, maxWait: 10000 })

      return NextResponse.json(serializeApi({
        confirmation,
        posting,
      }))
    } catch (error) {
      console.error('[POST /api/accounting/driver-cash/confirm]', error)
      return NextResponse.json({ error: '确认失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.confirm' })
}
