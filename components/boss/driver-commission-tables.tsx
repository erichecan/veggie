'use client'
import { eur } from '@/components/boss/analytics-shared'
import { formatDateTime } from '@/lib/format-date'
import {
  pivotPeriods,
  type DriverSummaryRow, type DriverPeriodRow, type DriverCommissionDetailRow,
} from '@/lib/analytics/driver-commission'

const th = 'px-3 py-1.5 font-medium'
const tdNum = 'px-3 py-1.5 text-right tabular-nums'

/** 冻结值与重算值之差。非零不一定是错——冻结后退货审核改过实送量就会这样，所以标黄不标红 */
function DiffCell({ diff, isEn }: { diff: number; isEn: boolean }) {
  if (Math.abs(diff) < 0.01) return <td className={`${tdNum} text-gray-300`}>—</td>
  return (
    <td
      className={`${tdNum} text-amber-700 font-medium`}
      title={isEn
        ? 'Recalculated value differs from the frozen value: the delivered quantity was changed after freezing, or this order is not yet frozen'
        : '重算值与冻结值不一致：冻结后实送量被改过，或该单尚未冻结'}
    >
      {diff > 0 ? `+${eur(diff)}` : eur(diff)}
    </td>
  )
}

type Picked = { id: string | null; name: string } | null

export function SummaryTable({ rows, onPick, picked, isEn = false }: {
  rows: DriverSummaryRow[]
  onPick: (d: Picked) => void
  picked: Picked
  isEn?: boolean
}) {
  const isPicked = (d: DriverSummaryRow) => picked?.name === d.driverName && picked?.id === d.driverId
  return (
    <div className="border rounded overflow-x-auto">
      <div className="px-3 py-2 bg-gray-50 text-sm font-medium">
        {isEn ? 'Grouped by driver (click a row to filter to that driver)' : '按司机汇总（点一行只看该司机）'}
      </div>
      <table className="w-full text-sm min-w-[900px]">
        <thead className="text-left text-gray-500">
          <tr>
            <th className={th}>{isEn ? 'Driver' : '司机'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Trips' : '行程'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Orders' : '订单'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Frozen' : '已冻结'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Delivered Amount' : '实送金额'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Item Commission' : '件提成'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Fixed Fee' : '固定费'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Rate Commission' : '比例提成'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Recalculated Total' : '重算合计'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Frozen Total' : '冻结合计'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Diff' : '差异'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr
              key={d.driverId ?? d.driverName}
              onClick={() => onPick(isPicked(d) ? null : { id: d.driverId, name: d.driverName })}
              className={`border-t cursor-pointer hover:bg-gray-50 ${isPicked(d) ? 'bg-purple-50' : ''}`}
            >
              <td className="px-3 py-1.5">{d.driverName}</td>
              <td className={`${tdNum} text-gray-500`}>{d.tripCount}</td>
              <td className={tdNum}>{d.orderCount}</td>
              <td className={`${tdNum} ${d.frozenOrderCount < d.orderCount ? 'text-amber-700' : 'text-gray-500'}`}>
                {d.frozenOrderCount}/{d.orderCount}
              </td>
              <td className={`${tdNum} text-gray-500`}>{eur(d.deliveredSubtotal)}</td>
              <td className={tdNum}>{eur(d.itemTotal)}</td>
              <td className={tdNum}>{eur(d.fixedFee)}</td>
              <td className={tdNum}>{eur(d.rateTotal)}</td>
              <td className={`${tdNum} font-medium`}>{eur(d.computedTotal)}</td>
              <td className={tdNum}>{eur(d.frozenTotal)}</td>
              <DiffCell diff={d.diff} isEn={isEn} />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No commission-earning trips in this period' : '期内没有产生提成的行程'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function PeriodTable({ rows, grainLabel, isEn = false }: { rows: DriverPeriodRow[]; grainLabel: string; isEn?: boolean }) {
  const { drivers, periods, cell, rowTotal } = pivotPeriods(rows)

  return (
    <div className="border rounded overflow-x-auto">
      <div className="px-3 py-2 bg-gray-50 text-sm font-medium">
        {isEn ? `By ${grainLabel} × Driver (recalculated total)` : `按${grainLabel} × 司机（重算合计）`}
      </div>
      <table className="w-full text-sm min-w-[600px]">
        <thead className="text-left text-gray-500">
          <tr>
            <th className={th}>{grainLabel}</th>
            {drivers.map(d => <th key={d} className={`${th} text-right`}>{d}</th>)}
            <th className={`${th} text-right`}>{isEn ? 'Total' : '合计'}</th>
          </tr>
        </thead>
        <tbody>
          {periods.map(p => {
            return (
              <tr key={p} className="border-t">
                <td className="px-3 py-1.5">{p}</td>
                {drivers.map(d => {
                  const c = cell(p, d)
                  return <td key={d} className={`${tdNum} ${c ? '' : 'text-gray-300'}`}>{c ? eur(c.computedTotal) : '—'}</td>
                })}
                <td className={`${tdNum} font-medium`}>{eur(rowTotal(p))}</td>
              </tr>
            )
          })}
          {periods.length === 0 && (
            <tr><td colSpan={2} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No data in this period' : '期内没有数据'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function DetailTable({ rows, truncated, locale, isEn = false }: {
  rows: DriverCommissionDetailRow[]
  truncated: boolean
  locale: string
  isEn?: boolean
}) {
  const prefix = locale === 'zh' ? '' : `/${locale}`
  return (
    <div className="border rounded overflow-x-auto">
      <div className="px-3 py-2 bg-gray-50 text-sm font-medium flex items-center justify-between">
        <span>{isEn ? 'Order Detail (commission = item commission + fixed fee + delivered amount × rate)' : '逐单明细（提成 = 件提成 + 固定费 + 实送金额 × 提成率）'}</span>
        {truncated && (
          <span className="text-xs text-amber-700">
            {isEn
              ? `Truncated: showing only the first ${rows.length} orders — narrow the date range or filter by driver to see all`
              : `已截断：只显示前 ${rows.length} 单，缩短日期区间或按司机筛选可看全`}
          </span>
        )}
      </div>
      <table className="w-full text-sm min-w-[1000px]">
        <thead className="text-left text-gray-500">
          <tr>
            <th className={th}>{isEn ? 'Date' : '日期'}</th>
            <th className={th}>{isEn ? 'Driver' : '司机'}</th>
            <th className={th}>{isEn ? 'Order' : '订单'}</th>
            <th className={th}>{isEn ? 'Customer' : '客户'}</th>
            <th className={th}>{isEn ? 'Status' : '状态'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Delivered Amount' : '实送金额'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Item Commission' : '件提成'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Fixed Fee' : '固定费'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Rate Commission' : '比例提成'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Recalculated Total' : '重算合计'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Frozen' : '冻结'}</th>
            <th className={`${th} text-right`}>{isEn ? 'Diff' : '差异'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.tripId}-${r.orderId}`} className="border-t">
              <td className="px-3 py-1.5 text-gray-500">{r.bizDate}</td>
              <td className="px-3 py-1.5">{r.driverName}</td>
              <td className="px-3 py-1.5">
                <a className="text-purple-700 hover:underline" href={`${prefix}/classic/operator/orders/${r.orderId}`}>
                  {r.orderCode ?? r.orderId.slice(0, 8)}
                </a>
              </td>
              <td className="px-3 py-1.5 text-gray-600">{r.restaurantName}</td>
              <td className="px-3 py-1.5 text-gray-500">{r.orderStatus}</td>
              <td className={`${tdNum} text-gray-500`}>{eur(r.deliveredSubtotal)}</td>
              <td className={tdNum}>{eur(r.itemTotal)}</td>
              <td className={tdNum}>{eur(r.fixedFee)}</td>
              <td className={tdNum}>{eur(r.rateTotal)}</td>
              <td className={`${tdNum} font-medium`}>{eur(r.computedTotal)}</td>
              <td className={tdNum}>
                {r.frozenAt
                  ? <span title={isEn ? `Frozen at ${formatDateTime(r.frozenAt)}` : `冻结于 ${formatDateTime(r.frozenAt)}`}>{eur(r.frozenTotal ?? 0)}</span>
                  : <span className="text-amber-700 text-xs">{isEn ? 'Not frozen' : '未冻结'}</span>}
              </td>
              <DiffCell diff={r.diff} isEn={isEn} />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No detail in this period' : '期内没有明细'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
