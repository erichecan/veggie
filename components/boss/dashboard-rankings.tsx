'use client'
import type { Order } from '@/lib/types'

const PURPLE = '#875A7B'

interface PO {
  supplierId: string
  status: string
  createdAt: string
  subtotalExTax: number
}

interface Supplier { id: string; name: string }

function MomBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-gray-300">新客</span>
  const isDown = pct < -30
  return (
    <span className={`text-xs font-medium ${
      isDown ? 'text-red-600' : pct >= 0 ? 'text-emerald-600' : 'text-gray-500'
    }`}>
      {pct >= 0 ? '+' : ''}{pct.toFixed(0)}%
      {isDown && ' ⚠️'}
    </span>
  )
}

function RankBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, background: color }} />
    </div>
  )
}

export function DashboardRankings({ orders, pos, suppliers }: {
  orders: Order[]
  pos: PO[]
  suppliers: Supplier[]
}) {
  const now = new Date()
  const moStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const lmoStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

  // Top 10 customers this month
  const custThis: Record<string, { name: string; amt: number }> = {}
  const custLast: Record<string, number> = {}
  orders.forEach(o => {
    if (o.createdAt >= moStart) {
      if (!custThis[o.restaurantId]) custThis[o.restaurantId] = { name: o.restaurantName, amt: 0 }
      custThis[o.restaurantId].amt += o.totalAmount
    } else if (o.createdAt >= lmoStart) {
      custLast[o.restaurantId] = (custLast[o.restaurantId] ?? 0) + o.totalAmount
    }
  })
  const topCustomers = Object.entries(custThis)
    .sort((a, b) => b[1].amt - a[1].amt)
    .slice(0, 10)
    .map(([id, { name, amt }]) => {
      const last = custLast[id]
      const change = last !== undefined ? ((amt - last) / last) * 100 : null
      return { id, name, amt, change }
    })

  // Top 10 products this month
  const prodThis: Record<string, number> = {}
  orders.forEach(o => {
    if (o.createdAt < moStart) return
    ;(o.lines ?? []).forEach(l => {
      prodThis[l.productName] = (prodThis[l.productName] ?? 0) + l.subtotal
    })
  })
  const topProducts = Object.entries(prodThis)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, amt]) => ({ name, amt }))

  // Top 5 suppliers this month
  const supplierMap = new Map(suppliers.map(s => [s.id, s.name]))
  const supThis: Record<string, number> = {}
  const confirmedStatuses = new Set(['CONFIRMED', 'RECEIVED', 'INVOICED'])
  pos.forEach(p => {
    if (p.createdAt >= moStart && confirmedStatuses.has(p.status)) {
      supThis[p.supplierId] = (supThis[p.supplierId] ?? 0) + p.subtotalExTax
    }
  })
  const topSuppliers = Object.entries(supThis)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, amt]) => ({ id, name: supplierMap.get(id) ?? id.slice(0, 8), amt }))

  const custMax = topCustomers[0]?.amt ?? 1
  const prodMax = topProducts[0]?.amt ?? 1
  const supMax  = topSuppliers[0]?.amt ?? 1

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Top customers */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 mb-4">本月客户 Top 10</h2>
        {topCustomers.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">本月暂无订单</p>
        ) : (
          <ol className="space-y-2.5">
            {topCustomers.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2">
                <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-yellow-400 text-yellow-900' :
                  i === 1 ? 'bg-gray-300 text-gray-700' :
                  i === 2 ? 'bg-orange-300 text-orange-800' :
                  'bg-gray-100 text-gray-500'
                }`}>{i + 1}</span>
                <span className="flex-1 text-xs text-gray-700 truncate">{c.name}</span>
                <RankBar value={c.amt} max={custMax} color={PURPLE} />
                <span className="text-xs font-bold w-16 text-right text-gray-800">€{c.amt.toFixed(0)}</span>
                <div className="w-14 text-right"><MomBadge pct={c.change} /></div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Top products */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 mb-4">本月商品 Top 10</h2>
        {topProducts.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">本月暂无销售数据</p>
        ) : (
          <ol className="space-y-2.5">
            {topProducts.map((p, i) => (
              <li key={p.name} className="flex items-center gap-2">
                <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-yellow-400 text-yellow-900' :
                  i === 1 ? 'bg-gray-300 text-gray-700' :
                  i === 2 ? 'bg-orange-300 text-orange-800' :
                  'bg-gray-100 text-gray-500'
                }`}>{i + 1}</span>
                <span className="flex-1 text-xs text-gray-700 truncate">{p.name}</span>
                <RankBar value={p.amt} max={prodMax} color="#4F86C6" />
                <span className="text-xs font-bold w-16 text-right text-gray-800">€{p.amt.toFixed(0)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Top suppliers */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 mb-4">本月供应商采购 Top 5</h2>
        {topSuppliers.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">本月暂无确认采购单</p>
        ) : (
          <ol className="space-y-2.5">
            {topSuppliers.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-yellow-400 text-yellow-900' :
                  i === 1 ? 'bg-gray-300 text-gray-700' :
                  i === 2 ? 'bg-orange-300 text-orange-800' :
                  'bg-gray-100 text-gray-500'
                }`}>{i + 1}</span>
                <span className="flex-1 text-xs text-gray-700 truncate">{s.name}</span>
                <RankBar value={s.amt} max={supMax} color="#e97c44" />
                <span className="text-xs font-bold w-16 text-right text-gray-800">€{s.amt.toFixed(0)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
