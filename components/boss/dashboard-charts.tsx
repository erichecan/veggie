'use client'
import {
  ResponsiveContainer, ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { Order } from '@/lib/types'

const PURPLE = '#875A7B'
const BLUE   = '#4F86C6'

interface PO {
  id: string
  status: string
  createdAt: string
  subtotalExTax: number
}

function buildLast30Days(orders: Order[], pos: PO[]) {
  const days: { date: string; label: string; sales: number; poCost: number }[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const next = new Date(d); next.setDate(next.getDate() + 1)
    const ds = d.toISOString(); const ns = next.toISOString()
    const sales = orders
      .filter(o => o.createdAt >= ds && o.createdAt < ns)
      .reduce((s, o) => s + o.totalAmount, 0)
    const poCost = pos
      .filter(p => p.createdAt >= ds && p.createdAt < ns)
      .reduce((s, p) => s + p.subtotalExTax, 0)
    days.push({
      date: ds,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      sales: parseFloat(sales.toFixed(2)),
      poCost: parseFloat(poCost.toFixed(2)),
    })
  }
  return days
}

function FunnelBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const w = max > 0 ? (count / max) * 100 : 0
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-14 text-right shrink-0">{label}</span>
      <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden relative">
        <div className="h-full rounded transition-all" style={{ width: `${w}%`, background: color }} />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white mix-blend-multiply"
          style={{ color: w > 40 ? '#fff' : '#555' }}>
          {count}
        </span>
      </div>
      <span className="text-xs font-bold w-10 text-gray-700">{w.toFixed(0)}%</span>
    </div>
  )
}

export function DashboardCharts({ orders, pos }: { orders: Order[]; pos: PO[] }) {
  const data = buildLast30Days(orders, pos)

  const now = new Date()
  const ninetyDaysAgo = new Date(now)
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const recentOrders = orders.filter(o => new Date(o.createdAt) >= ninetyDaysAgo)

  const funnelTotal = recentOrders.length
  const confirmed = recentOrders.filter(o =>
    ['confirmed', 'wave_assigned', 'in_delivery', 'completed'].includes(o.status)
  ).length
  const inDelivery = recentOrders.filter(o =>
    ['in_delivery', 'completed'].includes(o.status)
  ).length
  const completed = recentOrders.filter(o => o.status === 'completed').length

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* 30-day trend */}
      <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 mb-1">近 30 天营业额 vs 采购成本</h2>
        <p className="text-xs text-gray-400 mb-4">紫色柱 = 当日销售额，蓝色线 = 当日采购成本</p>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              interval={4}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `€${v}`}
            />
            <Tooltip
              formatter={(v: unknown, name: unknown) => [
                `€${Number(v).toFixed(2)}`,
                name === 'sales' ? '销售额' : '采购成本',
              ]}
              labelStyle={{ fontSize: 12 }}
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
            />
            <Bar dataKey="sales" fill={PURPLE} fillOpacity={0.85} radius={[2, 2, 0, 0]} name="sales" maxBarSize={18} />
            <Line dataKey="poCost" stroke={BLUE} strokeWidth={2} dot={false} name="poCost" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Sales funnel */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 mb-1">销售漏斗</h2>
        <p className="text-xs text-gray-400 mb-5">近 90 天订单转化</p>
        <div className="space-y-4">
          <FunnelBar label="报价" count={funnelTotal} max={funnelTotal} color="#c4b5d4" />
          <FunnelBar label="确认" count={confirmed} max={funnelTotal} color={PURPLE} />
          <FunnelBar label="配送中" count={inDelivery} max={funnelTotal} color="#5b4068" />
          <FunnelBar label="完成" count={completed} max={funnelTotal} color="#3d2a47" />
        </div>
        <div className="mt-5 pt-4 border-t border-gray-100 space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>报价 → 确认率</span>
            <span className="font-semibold text-gray-700">
              {funnelTotal > 0 ? `${((confirmed / funnelTotal) * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>确认 → 完成率</span>
            <span className="font-semibold text-gray-700">
              {confirmed > 0 ? `${((completed / confirmed) * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
