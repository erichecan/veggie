'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface OverviewStats {
  receipts: { total: number; recent: number }
  deliveries: { toProcess: number; inDelivery: number; completed: number }
  orders: { pending: number; confirmed: number; total: number }
  adjustments: { total: number; thisMonth: number }
  scrap: { total: number; thisMonth: number }
  discrepancies: { pending: number; total: number }
}

function StatCard({
  title,
  icon,
  stats,
  href,
  color = PURPLE,
}: {
  title: string
  icon: string
  stats: { label: string; value: number; highlight?: boolean }[]
  href: string
  color?: string
}) {
  const router = useRouter()
  return (
    <button
      onClick={() => router.push(href)}
      className="bg-white rounded-xl border shadow-sm p-5 text-left hover:shadow-md transition-shadow w-full"
      style={{ borderColor: BORDER }}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: `${color}20` }}>
          {icon}
        </div>
        <h3 className="font-semibold text-sm" style={{ color }}>
          {title}
        </h3>
      </div>
      <div className="space-y-2">
        {stats.map((s) => (
          <div key={s.label} className="flex items-center justify-between">
            <span className="text-xs text-gray-500">{s.label}</span>
            <span
              className="text-sm font-bold"
              style={{ color: s.highlight ? color : '#1f2d3d' }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-3 border-t text-xs font-medium" style={{ borderColor: '#f0e4ee', color: PURPLE }}>
        查看详情 →
      </div>
    </button>
  )
}

export default function InventoryPage() {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [stats, setStats] = useState<OverviewStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const [receipts, orders, moves] = await Promise.all([
          apiGet<{ total: number }>('/api/goods-receipts?limit=1'),
          apiGet<{ data?: unknown[]; total?: number } | unknown[]>('/api/orders?pageSize=1&page=1'),
          apiGet<{ total: number } | unknown[]>('/api/stock-moves?limit=1'),
        ])

        const now = new Date()
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

        const [recentReceipts, pendingOrders, confirmedOrders, inDeliveryOrders, completedOrders, adjustMoves, discPending, discAll] = await Promise.all([
          apiGet<{ total: number }>(`/api/goods-receipts?limit=1`),
          apiGet<{ total?: number } | unknown[]>('/api/orders?pageSize=1&page=1&status=PENDING'),
          apiGet<{ total?: number } | unknown[]>('/api/orders?pageSize=1&page=1&status=CONFIRMED'),
          apiGet<{ total?: number } | unknown[]>('/api/orders?pageSize=1&page=1&status=IN_DELIVERY'),
          apiGet<{ total?: number } | unknown[]>('/api/orders?pageSize=1&page=1&status=COMPLETED'),
          apiGet<unknown[]>('/api/stock-moves?limit=1000'),
          apiGet<{ total: number }>('/api/order-discrepancies?status=PENDING&limit=0'),
          apiGet<{ total: number }>('/api/order-discrepancies?limit=0'),
        ])

        const getTotal = (r: { total?: number } | unknown[]) =>
          Array.isArray(r) ? (r as unknown[]).length : ((r as { total?: number }).total ?? 0)

        const allMoves = Array.isArray(adjustMoves) ? adjustMoves as Array<{ type: string; movedAt?: string; createdAt: string }> : []
        const adjTotal = allMoves.filter((m) => m.type === 'ADJUSTMENT').length
        const adjMonth = allMoves.filter((m) => m.type === 'ADJUSTMENT' && (m.movedAt ?? m.createdAt) >= monthStart).length
        const scrapTotal = allMoves.filter((m) => m.type === 'SCRAP').length
        const scrapMonth = allMoves.filter((m) => m.type === 'SCRAP' && (m.movedAt ?? m.createdAt) >= monthStart).length

        setStats({
          receipts: {
            total: (receipts as { total: number }).total ?? 0,
            recent: (recentReceipts as { total: number }).total ?? 0,
          },
          deliveries: {
            toProcess: getTotal(confirmedOrders as { total?: number }),
            inDelivery: getTotal(inDeliveryOrders as { total?: number }),
            completed: getTotal(completedOrders as { total?: number }),
          },
          orders: {
            pending: getTotal(pendingOrders as { total?: number }),
            confirmed: getTotal(confirmedOrders as { total?: number }),
            total: getTotal(orders as { total?: number }),
          },
          adjustments: { total: adjTotal, thisMonth: adjMonth },
          scrap: { total: scrapTotal, thisMonth: scrapMonth },
          discrepancies: {
            pending: (discPending as { total: number }).total ?? 0,
            total: (discAll as { total: number }).total ?? 0,
          },
        })
      } catch {
        setStats({
          receipts: { total: 0, recent: 0 },
          deliveries: { toProcess: 0, inDelivery: 0, completed: 0 },
          orders: { pending: 0, confirmed: 0, total: 0 },
          adjustments: { total: 0, thisMonth: 0 },
          scrap: { total: 0, thisMonth: 0 },
          discrepancies: { pending: 0, total: 0 },
        })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <p className="text-xs text-gray-400">库存管理</p>
        <h1 className="text-xl font-semibold" style={{ color: PURPLE }}>库存概览</h1>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-white rounded-xl border p-5 animate-pulse h-44" style={{ borderColor: BORDER }} />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="收货单"
            icon="📦"
            href={`${prefix}/classic/operator/inventory/receipts`}
            stats={[
              { label: '全部收货单', value: stats.receipts.total },
              { label: '待处理', value: 0 },
              { label: '本月到货', value: stats.receipts.recent },
            ]}
          />
          <StatCard
            title="发货单"
            icon="🚚"
            href={`${prefix}/classic/operator/inventory/deliveries`}
            stats={[
              { label: '待发货', value: stats.deliveries.toProcess, highlight: stats.deliveries.toProcess > 0 },
              { label: '配送中', value: stats.deliveries.inDelivery, highlight: stats.deliveries.inDelivery > 0 },
              { label: '已完成', value: stats.deliveries.completed },
            ]}
          />
          <StatCard
            title="销售订单"
            icon="🧾"
            href={`${prefix}/classic/operator/inventory/deliveries`}
            stats={[
              { label: '待确认', value: stats.orders.pending, highlight: stats.orders.pending > 0 },
              { label: '已确认', value: stats.orders.confirmed },
              { label: '全部订单', value: stats.orders.total },
            ]}
          />
          <StatCard
            title="库存调整"
            icon="📋"
            href={`${prefix}/classic/operator/inventory/adjustments`}
            stats={[
              { label: '本月调整', value: stats.adjustments.thisMonth },
              { label: '历史记录', value: stats.adjustments.total },
            ]}
          />
          <StatCard
            title="报废管理"
            icon="🗑️"
            href={`${prefix}/classic/operator/inventory/scrap`}
            stats={[
              { label: '本月报废', value: stats.scrap.thisMonth, highlight: stats.scrap.thisMonth > 0 },
              { label: '历史记录', value: stats.scrap.total },
            ]}
          />
          <StatCard
            title="拣货差异"
            icon="⚠️"
            href={`${prefix}/classic/operator/inventory/discrepancies`}
            stats={[
              { label: '待处理', value: stats.discrepancies.pending, highlight: stats.discrepancies.pending > 0 },
              { label: '全部记录', value: stats.discrepancies.total },
            ]}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          { title: '快速导航', links: [
            { label: '查看收货单列表', href: `${prefix}/classic/operator/inventory/receipts` },
            { label: '查看发货单列表', href: `${prefix}/classic/operator/inventory/deliveries` },
            { label: '库存调整记录', href: `${prefix}/classic/operator/inventory/adjustments` },
            { label: '报废管理', href: `${prefix}/classic/operator/inventory/scrap` },
            { label: '拣货差异处理', href: `${prefix}/classic/operator/inventory/discrepancies` },
          ]},
          { title: '关联模块', links: [
            { label: '采购订单', href: `${prefix}/classic/operator/purchases` },
            { label: '销售订单', href: `${prefix}/classic/operator/orders` },
            { label: '配送单', href: `${prefix}/classic/operator/trips` },
          ]},
        ].map((section) => (
          <div key={section.title} className="bg-white rounded-xl border p-4" style={{ borderColor: BORDER }}>
            <h4 className="text-xs font-semibold mb-3" style={{ color: PURPLE }}>{section.title}</h4>
            <div className="space-y-1">
              {section.links.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className="block text-sm text-gray-600 hover:text-purple-700 py-1 hover:underline"
                >
                  {l.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
