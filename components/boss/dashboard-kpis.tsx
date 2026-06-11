'use client'
import type { Order } from '@/lib/types'

const PURPLE = '#875A7B'

interface PO {
  id: string
  supplierId: string
  status: string
  createdAt: string
  subtotalExTax: number
}

function fmt(n: number) { return `€${n.toFixed(2)}` }
function pct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` }

function delta(current: number, prev: number) {
  if (prev === 0) return current > 0 ? '+∞' : '—'
  return pct(((current - prev) / prev) * 100)
}

function sumAmount(orders: Order[]) {
  return orders.reduce((s, o) => s + o.totalAmount, 0)
}

function KpiCard({
  label, value, sub, badge, badgeOk, accent,
}: {
  label: string; value: string; sub?: string
  badge?: string; badgeOk?: boolean; accent?: boolean
}) {
  return (
    <div className={`bg-white rounded-xl border p-5 shadow-sm ${accent ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
      <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${accent ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
      <div className="flex items-center gap-2 mt-1.5">
        {badge && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            badgeOk === false ? 'bg-red-100 text-red-600'
            : badgeOk === true ? 'bg-emerald-100 text-emerald-700'
            : 'bg-gray-100 text-gray-500'
          }`}>{badge}</span>
        )}
        {sub && <span className="text-xs text-gray-400">{sub}</span>}
      </div>
    </div>
  )
}

export function DashboardKpis({ orders, pos, debt, debtHref }: {
  orders: Order[]; pos: PO[]
  debt?: number | null; debtHref?: string
}) {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const ystStart = new Date(todayStart); ystStart.setDate(ystStart.getDate() - 1)
  const wkStart = new Date(todayStart); wkStart.setDate(wkStart.getDate() - ((wkStart.getDay() + 6) % 7))
  const lwkStart = new Date(wkStart); lwkStart.setDate(lwkStart.getDate() - 7)
  const moStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lmoStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const inRange = (o: Order, from: Date, to?: Date) => {
    const t = new Date(o.createdAt)
    return t >= from && (!to || t < to)
  }
  const poInRange = (p: PO, from: Date, to?: Date) => {
    const t = new Date(p.createdAt)
    return t >= from && (!to || t < to)
  }

  const todaySales = sumAmount(orders.filter(o => inRange(o, todayStart)))
  const ystSales   = sumAmount(orders.filter(o => inRange(o, ystStart, todayStart)))
  const thisWkSales = sumAmount(orders.filter(o => inRange(o, wkStart)))
  const lastWkSales = sumAmount(orders.filter(o => inRange(o, lwkStart, wkStart)))
  const thisMonthSales = sumAmount(orders.filter(o => inRange(o, moStart)))
  const lastMonthSales = sumAmount(orders.filter(o => inRange(o, lmoStart, moStart)))

  const confirmedStatuses = new Set(['CONFIRMED', 'RECEIVED', 'INVOICED'])
  const thisMonthPOCost = pos
    .filter(p => poInRange(p, moStart) && confirmedStatuses.has(p.status))
    .reduce((s, p) => s + p.subtotalExTax, 0)

  const marginPct = thisMonthSales > 0
    ? ((thisMonthSales - thisMonthPOCost) / thisMonthSales) * 100
    : null

  const pendingOrders = orders.filter(o => o.status === 'pending').length
  const unconfirmedPOs = pos.filter(p => p.status === 'DRAFT' || p.status === 'SENT').length

  const todayDelta = delta(todaySales, ystSales)
  const wkDelta = delta(thisWkSales, lastWkSales)
  const moDelta = delta(thisMonthSales, lastMonthSales)
  const todayOk = todaySales >= ystSales
  const wkOk = thisWkSales >= lastWkSales

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <KpiCard label="今日营业额" value={fmt(todaySales)}
        badge={todayDelta} badgeOk={todayOk} sub="对比昨日" />
      <KpiCard label="本周营业额" value={fmt(thisWkSales)}
        badge={wkDelta} badgeOk={wkOk} sub="对比上周" />
      <KpiCard label="本月营业额" value={fmt(thisMonthSales)}
        badge={moDelta} badgeOk={thisMonthSales >= lastMonthSales} sub="对比上月" />
      <KpiCard
        label="本月毛利率"
        value={marginPct !== null ? `${marginPct.toFixed(1)}%` : '—'}
        sub={`采购成本 ${fmt(thisMonthPOCost)}`}
        badge={marginPct !== null ? (marginPct >= 20 ? '健康' : '偏低') : undefined}
        badgeOk={marginPct !== null ? marginPct >= 20 : undefined}
      />
      <KpiCard
        label="待确认报价"
        value={`${pendingOrders} 单`}
        sub="未确认"
        badge={pendingOrders > 5 ? '需关注' : '正常'}
        badgeOk={pendingOrders <= 5}
        accent={pendingOrders > 5}
      />
      <KpiCard
        label="未到货采购单"
        value={`${unconfirmedPOs} 单`}
        sub="DRAFT/SENT"
        badge={unconfirmedPOs > 3 ? '需跟进' : '正常'}
        badgeOk={unconfirmedPOs <= 3}
        accent={unconfirmedPOs > 3}
      />
      {debt !== undefined && (
        debtHref ? (
          <a href={debtHref} className="block">
            <KpiCard
              label="欠款总额(含上期)"
              value={debt !== null ? fmt(debt) : '—'}
              sub="点击查看财务明细 →"
              badge={debt !== null && debt > 0 ? '待收' : '无欠款'}
              badgeOk={debt !== null ? debt <= 0 : undefined}
              accent={debt !== null && debt > 0}
            />
          </a>
        ) : (
          <KpiCard
            label="欠款总额(含上期)"
            value={debt !== null ? fmt(debt) : '—'}
            badge={debt !== null && debt > 0 ? '待收' : '无欠款'}
            badgeOk={debt !== null ? debt <= 0 : undefined}
            accent={debt !== null && debt > 0}
          />
        )
      )}
    </div>
  )
}
