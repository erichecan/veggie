'use client'
import { useState, useEffect } from 'react'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
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

  useEffect(() => {
    Promise.all([
      apiGet<Order[]>('/api/orders?include_lines=false'),
      apiGet<PO[]>('/api/purchase-orders?limit=500'),
      apiGet<{ id: string; name: string }[]>('/api/customers?isVendor=true&limit=200'),
    ]).then(([o, p, s]) => {
      setOrders(o)
      setPos(p.map(po => ({
        ...po,
        subtotalExTax: Number(po.subtotalExTax),
      })))
      setSuppliers(s)
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
      <DashboardKpis orders={orders} pos={pos} />

      {/* Layer 2: Trend + Funnel */}
      <DashboardCharts orders={orders} pos={pos} />

      {/* Layer 3: Rankings */}
      <DashboardRankings orders={orders} pos={pos} suppliers={suppliers} />
    </div>
  )
}
