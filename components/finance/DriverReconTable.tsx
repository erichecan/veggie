'use client'
import type { ReconRow } from '@/lib/driver-reconciliation'
import { RECON_STATUS_LABEL } from '@/lib/driver-reconciliation'

/**
 * 司机对账表（台账 C10）
 *
 * 三条显示约定：
 * · **差异标红**，且同时显示申报值与系统值 —— 只给一个差额，财务还得回去翻两处才知道谁高谁低
 * · **未提交的行申报列打「—」而不是 0**：「报了 0」与「没报」在账上是两件事
 * · 未提交但当天确实有行程的，把行程数摆出来 —— 那是「该报没报」的凭据
 */

const eur = (n: number) => `€${n.toFixed(2)}`

const STATUS_STYLE: Record<ReconRow['status'], string> = {
  not_submitted: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-50 text-blue-700',
  confirmed: 'bg-green-50 text-green-700',
}

/** 一格「申报 / 系统」。对不上时整格标红并给出差额 */
function Cmp({ declared, system, diff, money }: {
  declared: number | null
  system: number
  diff: number | undefined
  money?: boolean
}) {
  const fmt = (n: number) => (money ? eur(n) : String(n))
  const bad = diff !== undefined
  return (
    <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${bad ? 'bg-red-50 text-red-700 font-medium' : ''}`}>
      <div>{declared === null ? <span className="text-gray-400">—</span> : fmt(declared)}</div>
      <div className="text-xs text-gray-500">系统 {fmt(system)}</div>
      {bad && <div className="text-xs font-semibold">差 {diff > 0 ? '+' : ''}{fmt(diff)}</div>}
    </td>
  )
}

export default function DriverReconTable({ rows, onConfirm, acting }: {
  rows: ReconRow[]
  onConfirm: (row: ReconRow) => void
  acting: string | null
}) {
  if (rows.length === 0) {
    return (
      <div className="border rounded p-10 text-center text-gray-500">
        该区间内没有符合条件的对账记录
      </div>
    )
  }

  return (
    <div className="border rounded overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">业务日</th>
            <th className="px-3 py-2 font-medium">司机</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 font-medium">收回现金</th>
            <th className="px-3 py-2 font-medium">订单总额</th>
            <th className="px-3 py-2 font-medium">退货</th>
            <th className="px-3 py-2 font-medium">换货</th>
            <th className="px-3 py-2 font-medium">行程</th>
            <th className="px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(r => {
            const d = (f: string) => r.diffs.find(x => x.field === f)?.diff
            const key = `${r.driverId}|${r.date}`
            return (
              <tr key={key} className={r.hasDiff ? 'bg-red-50/30' : ''}>
                <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.driverName}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[r.status]}`}>
                    {RECON_STATUS_LABEL[r.status]}
                  </span>
                  {r.hasDiff && (
                    <span className="ml-1 px-2 py-0.5 rounded text-xs bg-red-100 text-red-700">
                      {r.diffs.length} 项对不上
                    </span>
                  )}
                </td>
                <Cmp declared={r.declared?.cashCollected ?? null} system={r.system.cashCollected}
                     diff={d('cashCollected')} money />
                <Cmp declared={r.declared?.orderTotal ?? null} system={r.system.orderTotal}
                     diff={d('orderTotal')} money />
                <Cmp declared={r.declared?.returnCount ?? null} system={r.system.returnCount}
                     diff={d('returnCount')} />
                <Cmp declared={r.declared?.exchangeCount ?? null} system={r.system.exchangeCount}
                     diff={d('exchangeCount')} />
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                  {r.system.tripIds.length} 趟
                  {r.system.unsettledTripCount > 0 && (
                    <span className="block text-xs text-amber-700">
                      {r.system.unsettledTripCount} 趟未交账
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.status === 'submitted' && (
                    <button
                      onClick={() => onConfirm(r)}
                      disabled={acting === key}
                      className="px-3 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-50"
                    >
                      {acting === key ? '确认中…' : '确认'}
                    </button>
                  )}
                  {r.status === 'confirmed' && (
                    <span className="text-xs text-gray-500">
                      {r.confirmedByName || '已确认'}
                    </span>
                  )}
                  {r.status === 'not_submitted' && (
                    <span className="text-xs text-gray-400">待司机提交</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
