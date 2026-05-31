'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet } from '@/lib/api'
import type { Order, Customer } from '@/lib/types'
import { DrillPanel, type DrillColumn } from '@/components/shared/drill-panel'

const PURPLE = '#875A7B'

type CardKey = 'todayCash' | 'todayOnline' | 'unpaid' | 'totalDebt' | 'commission'

function todayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

const TERM_LABEL: Record<string, string> = {
  cash: '现付',
  weekly: '周结',
  monthly: '月结',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  wave_assigned: '拣货中',
  in_delivery: '配送中',
  confirmed: '已确认',
  completed: '已完成',
}

interface UnpaidGroup {
  customer: Customer
  orders: Order[]
  totalOwed: number
  historicalDebt: number
}

interface CommissionGroup {
  customer: Customer
  completedTotal: number
  commissionRate: number
  commission: number
}

export default function ClassicFinancePage() {
  const router = useRouter()
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [historicalDebt, setHistoricalDebt] = useState<Record<string, number>>({})
  const [activeCard, setActiveCard] = useState<CardKey | null>(null)

  useEffect(() => {
    apiGet<Order[]>('/api/orders?include_lines=false').then(data => setOrders(data)).catch(() => {})
    apiGet<Customer[]>('/api/customers').then(data => setCustomers(data)).catch(() => {})
    apiGet<Record<string, number>>('/api/finance/historical-debt').then(setHistoricalDebt).catch(() => {})
  }, [])

  const today = todayStart()

  const todayCashOrders = orders.filter(o =>
    o.status.toLowerCase() === 'completed' && o.paymentMethod === 'cash' && o.createdAt >= today
  )
  const todayCash = todayCashOrders.reduce((s, o) => s + o.totalAmount, 0)

  const todayOnlineOrders = orders.filter(o =>
    o.status.toLowerCase() === 'completed' && o.paymentMethod === 'online' && o.createdAt >= today
  )
  const todayOnline = todayOnlineOrders.reduce((s, o) => s + o.totalAmount, 0)

  const unpaidOrders = orders.filter(o =>
    o.status.toLowerCase() !== 'completed' &&
    customers.find(c => c.id === o.restaurantId)?.paymentTerm !== 'cash'
  )

  const unpaidGroups: UnpaidGroup[] = customers
    .filter(c => c.paymentTerm !== 'cash')
    .map(c => {
      const cOrders = unpaidOrders.filter(o => o.restaurantId === c.id)
      return {
        customer: c,
        orders: cOrders,
        totalOwed: cOrders.reduce((s, o) => s + o.totalAmount, 0),
        historicalDebt: historicalDebt[c.id] ?? 0,
      }
    })
    .filter(g => g.orders.length > 0 || g.historicalDebt > 0)

  const totalUnpaid = unpaidGroups.reduce((s, g) => s + g.totalOwed + g.historicalDebt, 0)
  const totalHistoricalDebt = Object.values(historicalDebt).reduce((s, v) => s + v, 0)
  const totalCurrentUnpaid = unpaidGroups.reduce((s, g) => s + g.totalOwed, 0)

  const commissionGroups: CommissionGroup[] = customers
    .filter(c => c.commissionRate != null && c.commissionRate > 0)
    .map(c => {
      const completedTotal = orders
        .filter(o => o.restaurantId === c.id && o.status.toLowerCase() === 'completed')
        .reduce((s, o) => s + o.totalAmount, 0)
      const commission = completedTotal * (c.commissionRate ?? 0)
      return { customer: c, completedTotal, commissionRate: c.commissionRate!, commission }
    })
    .filter(g => g.completedTotal > 0)

  const totalCommission = commissionGroups.reduce((s, g) => s + g.commission, 0)
  const todayLabel = new Date().toLocaleDateString('en-GB', { month: 'long', day: 'numeric', weekday: 'long' })

  function toggleCard(key: CardKey) {
    setActiveCard(prev => (prev === key ? null : key))
  }

  // ─── 列定义 ─────────────────────────────────────────────────────────────────
  const orderColumns: DrillColumn<Order>[] = [
    {
      key: 'code', label: '订单号', render: o =>
        <span className="font-mono text-xs text-gray-700">{o.code ?? o.id.slice(-8)}</span>,
    },
    { key: 'restaurant', label: '客户', render: o => <span className="text-gray-800">{o.restaurantName}</span> },
    {
      key: 'time', label: '时间', render: o =>
        <span className="text-xs text-gray-500">
          {new Date(o.createdAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </span>,
    },
    {
      key: 'payment', label: '付款方式', align: 'center', render: o => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
          o.paymentMethod === 'cash' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
        }`}>
          {o.paymentMethod === 'cash' ? '现付' : '转账'}
        </span>
      ),
    },
    {
      key: 'status', label: '状态', align: 'center', render: o =>
        <span className="text-xs text-gray-600">{STATUS_LABEL[o.status.toLowerCase()] ?? o.status}</span>,
    },
    {
      key: 'amount', label: '金额', align: 'right', render: o =>
        <span className="font-semibold text-gray-900">€{o.totalAmount.toFixed(2)}</span>,
    },
  ]

  type UnpaidRow = UnpaidGroup & { totalDue: number }
  const unpaidColumns: DrillColumn<UnpaidRow>[] = [
    { key: 'name', label: '客户', render: g => <span className="text-gray-800 font-medium">{g.customer.name}</span> },
    {
      key: 'term', label: '账期', align: 'center', render: g => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
          g.customer.paymentTerm === 'monthly' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
        }`}>
          {TERM_LABEL[g.customer.paymentTerm]}
        </span>
      ),
    },
    {
      key: 'orderCount', label: '未结订单', align: 'right', render: g =>
        <span className="text-gray-700">{g.orders.length} 单</span>,
    },
    {
      key: 'history', label: '历史欠款', align: 'right', render: g =>
        g.historicalDebt > 0
          ? <span className="text-red-700">€{g.historicalDebt.toFixed(2)}</span>
          : <span className="text-gray-300">—</span>,
    },
    {
      key: 'total', label: '合计应收', align: 'right', render: g =>
        <span className="font-bold text-red-700">€{g.totalDue.toFixed(2)}</span>,
    },
  ]

  const commissionColumns: DrillColumn<CommissionGroup>[] = [
    { key: 'name', label: '客户', render: g => <span className="text-gray-800 font-medium">{g.customer.name}</span> },
    {
      key: 'completed', label: '已完成订单额', align: 'right', render: g =>
        <span className="text-gray-700">€{g.completedTotal.toFixed(2)}</span>,
    },
    {
      key: 'rate', label: '佣金率', align: 'right', render: g =>
        <span className="font-medium" style={{ color: PURPLE }}>{Math.round(g.commissionRate * 100)}%</span>,
    },
    {
      key: 'commission', label: '应付佣金', align: 'right', render: g =>
        <span className="font-bold" style={{ color: PURPLE }}>€{g.commission.toFixed(2)}</span>,
    },
  ]

  function gotoOrder(o: Order) { router.push(`/classic/operator/orders/${o.id}`) }
  function gotoCustomer(c: Customer) { router.push(`/classic/operator/customers/${c.id}`) }

  function renderPanel() {
    if (!activeCard) return null
    const close = () => setActiveCard(null)

    if (activeCard === 'todayCash') {
      return (
        <DrillPanel<Order>
          title="今日现金收款明细"
          fullListHref="/classic/operator/orders"
          columns={orderColumns}
          rows={todayCashOrders}
          rowKey={o => o.id}
          onRowClick={gotoOrder}
          emptyText="今日暂无现金收款"
          onClose={close}
          footer={`合计 €${todayCash.toFixed(2)}`}
        />
      )
    }
    if (activeCard === 'todayOnline') {
      return (
        <DrillPanel<Order>
          title="今日转账收款明细"
          fullListHref="/classic/operator/orders"
          columns={orderColumns}
          rows={todayOnlineOrders}
          rowKey={o => o.id}
          onRowClick={gotoOrder}
          emptyText="今日暂无转账收款"
          onClose={close}
          footer={`合计 €${todayOnline.toFixed(2)}`}
        />
      )
    }
    if (activeCard === 'unpaid' || activeCard === 'totalDebt') {
      const includeHistorical = activeCard === 'totalDebt'
      const rows: UnpaidRow[] = unpaidGroups
        .map(g => ({
          ...g,
          totalDue: includeHistorical ? g.totalOwed + g.historicalDebt : g.totalOwed,
        }))
        .filter(g => g.totalDue > 0)
        .sort((a, b) => b.totalDue - a.totalDue)
      return (
        <DrillPanel<UnpaidRow>
          title={includeHistorical ? '欠款客户明细（含历史）' : '本期未结款客户'}
          fullListHref="/classic/operator/customers"
          columns={unpaidColumns}
          rows={rows}
          rowKey={g => g.customer.id}
          onRowClick={g => gotoCustomer(g.customer)}
          emptyText="暂无欠款客户"
          onClose={close}
          footer={includeHistorical
            ? `本期 €${totalCurrentUnpaid.toFixed(2)} + 历史 €${totalHistoricalDebt.toFixed(2)} = €${totalUnpaid.toFixed(2)}`
            : `合计 €${totalCurrentUnpaid.toFixed(2)}`}
        />
      )
    }
    if (activeCard === 'commission') {
      return (
        <DrillPanel<CommissionGroup>
          title="应付销售佣金明细"
          fullListHref="/classic/operator/customers"
          columns={commissionColumns}
          rows={[...commissionGroups].sort((a, b) => b.commission - a.commission)}
          rowKey={g => g.customer.id}
          onRowClick={g => gotoCustomer(g.customer)}
          emptyText="暂无佣金应付"
          onClose={close}
          footer={`合计 €${totalCommission.toFixed(2)}`}
        />
      )
    }
    return null
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">财务总览</h1>
        <p className="text-sm text-gray-500 mt-1">{todayLabel} · 数据实时来自数据库</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <MetricCard label="今日现金收款" value={`€${todayCash.toFixed(2)}`} sub="司机现收·已到账" icon="💵" color="text-orange-600" border="border-orange-200" bg="bg-orange-50" active={activeCard === 'todayCash'} onClick={() => toggleCard('todayCash')} />
        <MetricCard label="今日转账收款" value={`€${todayOnline.toFixed(2)}`} sub="线上支付·已到账" icon="💳" color="text-emerald-700" border="border-emerald-200" bg="bg-emerald-50" active={activeCard === 'todayOnline'} onClick={() => toggleCard('todayOnline')} />
        <MetricCard label="本期未结款" value={`€${totalCurrentUnpaid.toFixed(2)}`} sub={`${unpaidGroups.filter(g => g.orders.length > 0).length} 家客户·待收`} icon="📋" color="text-amber-700" border="border-amber-200" bg="bg-amber-50" active={activeCard === 'unpaid'} onClick={() => toggleCard('unpaid')} />
        <MetricCard label="欠款总额（含上期）" value={`€${totalUnpaid.toFixed(2)}`} sub={`含上期历史欠款 €${totalHistoricalDebt.toFixed(2)}`} icon="⚠️" color="text-red-700" border="border-red-200" bg="bg-red-50" active={activeCard === 'totalDebt'} onClick={() => toggleCard('totalDebt')} />
        <MetricCard label="应付销售佣金" value={`€${totalCommission.toFixed(2)}`} sub={`${commissionGroups.length} 家客户·已完成订单`} icon="🤝" color="text-purple-700" border="border-purple-200" bg="bg-purple-50" active={activeCard === 'commission'} onClick={() => toggleCard('commission')} />
      </div>

      {renderPanel()}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3" style={{ background: '#f3eff5' }}>
          <span className="text-lg">📋</span>
          <h2 className="font-bold text-gray-800">未结款明细（按客户）</h2>
          <span className="ml-auto text-xs text-gray-500">仅展示周结 / 月结客户</span>
        </div>

        {unpaidGroups.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">暂无未结款项 · 所有订单已结清</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {unpaidGroups.map(g => (
              <div key={g.customer.id} className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-gray-900">{g.customer.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      g.customer.paymentTerm === 'monthly'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-purple-100 text-purple-700'
                    }`}>
                      {TERM_LABEL[g.customer.paymentTerm]}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-red-700">€{(g.totalOwed + g.historicalDebt).toFixed(2)}</div>
                    <div className="text-xs text-gray-500">合计应收</div>
                  </div>
                </div>

                {g.orders.length > 0 && (
                  <div className="bg-gray-50 rounded-lg overflow-hidden mb-2">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left px-3 py-1.5 text-gray-500 font-medium">订单号</th>
                          <th className="text-left px-3 py-1.5 text-gray-500 font-medium">下单时间</th>
                          <th className="text-left px-3 py-1.5 text-gray-500 font-medium">支付方式</th>
                          <th className="text-left px-3 py-1.5 text-gray-500 font-medium">状态</th>
                          <th className="text-right px-3 py-1.5 text-gray-500 font-medium">金额</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {g.orders.map(o => (
                          <tr key={o.id}>
                            <td className="px-3 py-1.5 font-mono text-gray-400">{o.id.slice(-8)}</td>
                            <td className="px-3 py-1.5 text-gray-600">{new Date(o.createdAt).toLocaleString('en-GB')}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                o.paymentMethod === 'cash' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                              }`}>
                                {o.paymentMethod === 'cash' ? '现收' : '转账'}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-gray-500">
                              {STATUS_LABEL[o.status.toLowerCase()] ?? o.status}
                            </td>
                            <td className="px-3 py-1.5 text-right font-medium text-gray-900">€{o.totalAmount.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {g.historicalDebt > 0 && (
                  <div className="flex items-center justify-between px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-sm">
                    <span className="text-red-600">📌 上期结转欠款</span>
                    <span className="font-bold text-red-700">€{g.historicalDebt.toFixed(2)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3" style={{ background: '#f3eff5' }}>
          <span className="text-lg">🤝</span>
          <h2 className="font-bold text-gray-800">销售佣金明细</h2>
          <span className="ml-auto text-xs text-gray-500">仅统计已完成订单</span>
        </div>
        {commissionGroups.length === 0 ? (
          <div className="py-10 text-center text-gray-400 text-sm">暂无已完成订单，佣金数据为 0</div>
        ) : (
          <table className="w-full text-sm">
            <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-gray-600">客户</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-gray-600">已完成订单额</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-gray-600">佣金率</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-gray-600">应付佣金</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {commissionGroups.map(g => (
                <tr key={g.customer.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{g.customer.name}</td>
                  <td className="px-5 py-3 text-right text-gray-600">€{g.completedTotal.toFixed(2)}</td>
                  <td className="px-5 py-3 text-right">
                    <span className="font-medium" style={{ color: PURPLE }}>{Math.round(g.commissionRate * 100)}%</span>
                  </td>
                  <td className="px-5 py-3 text-right font-bold" style={{ color: PURPLE }}>€{g.commission.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-gray-200" style={{ background: '#f3eff5' }}>
              <tr>
                <td colSpan={3} className="px-5 py-2.5 text-sm font-semibold text-gray-700">合计</td>
                <td className="px-5 py-2.5 text-right font-bold text-base" style={{ color: PURPLE }}>€{totalCommission.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className="mt-6 rounded-xl p-4 text-sm" style={{ background: '#f3eff5', border: '1px solid #d4c0d4' }}>
        <p className="font-semibold mb-1" style={{ color: PURPLE }}>💡 结算说明</p>
        <ul className="space-y-0.5 text-xs list-disc list-inside text-gray-600">
          <li>现付客户：司机送达时当场收款，行程完成后自动入账</li>
          <li>周结客户：每周汇总本期应收，下单后进入待收账款</li>
          <li>月结客户：每月月末统一结算，订单金额累积至本期账款</li>
          <li>历史欠款为上一结算周期的未清余额，需单独追收</li>
        </ul>
      </div>
    </div>
  )
}

function MetricCard({
  label, value, sub, icon, color, border, bg, active, onClick,
}: {
  label: string
  value: string
  sub?: string
  icon: string
  color: string
  border: string
  bg: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border ${border} ${bg} p-5 shadow-sm transition-all w-full ${
        active ? 'ring-2 ring-amber-300 shadow-md' : 'hover:shadow-md hover:opacity-95'
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 mb-1 flex items-center gap-1">
            {label}
            <span className="text-[10px] text-gray-400">{active ? '▾' : '›'}</span>
          </p>
          <p className={`text-2xl font-bold ${color}`}>{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </button>
  )
}
