'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import type { Order, Customer } from '@/lib/types'
import { DashboardKpis } from '@/components/boss/dashboard-kpis'
import { DashboardCharts } from '@/components/boss/dashboard-charts'
import { DashboardRankings } from '@/components/boss/dashboard-rankings'

interface PO {
  id: string
  supplierId: string
  status: string
  createdAt: string
  subtotalExTax: number
}

interface Supplier { id: string; name: string }

export default function ClassicBossDashboard() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [pos, setPos] = useState<PO[] | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [debt, setDebt] = useState<number | null>(null)
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    Promise.all([
      apiGet<Order[]>('/api/orders?include_lines=false'),
      apiGet<PO[]>('/api/purchase-orders?limit=500'),
      apiGet<{ id: string; name: string }[]>('/api/customers?isVendor=true&limit=200'),
      apiGet<Customer[]>('/api/customers'),
      apiGet<Record<string, number>>('/api/finance/historical-debt'),
    ]).then(([o, p, s, customers, historical]) => {
      setOrders(o)
      setPos(p.map(po => ({
        ...po,
        subtotalExTax: Number(po.subtotalExTax),
      })))
      setSuppliers(s)

      // 欠款总额 = 本期未结(非现结客户的未完成订单) + 历史欠款,口径与财务总览一致
      const creditCustomers = new Set(
        customers.filter(c => c.paymentTerm !== 'cash').map(c => c.id),
      )
      const currentUnpaid = o
        .filter(ord => ord.status.toLowerCase() !== 'completed' && creditCustomers.has(ord.restaurantId))
        .reduce((s2, ord) => s2 + ord.totalAmount, 0)
      const historicalTotal = Object.values(historical).reduce((s2, v) => s2 + v, 0)
      setDebt(currentUnpaid + historicalTotal)
    }).catch(() => {})
  }, [])

  if (!orders || !pos) {
    return (
      <div className="flex items-center justify-center py-32 text-gray-400 text-sm">
        加载中…
      </div>
    )
  }

  const todayLabel = new Date().toLocaleDateString('en-GB', {
    month: 'long', day: 'numeric', weekday: 'long',
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">经营总览</h1>
        <p className="text-sm text-gray-400 mt-0.5">{todayLabel} · 数据实时来自数据库</p>
      </div>

      {/* Layer 1: KPI Cards */}
      <DashboardKpis orders={orders} pos={pos} debt={debt} debtHref={`${prefix}/classic/finance`} />

      {/* Layer 2: Trend + Funnel */}
      <DashboardCharts orders={orders} pos={pos} />

      {/* Layer 3: Rankings */}
      <DashboardRankings orders={orders} pos={pos} suppliers={suppliers} />
    </div>
  )
}
