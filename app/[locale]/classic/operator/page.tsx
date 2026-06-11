'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

interface WorkbenchCounts {
  pendingQuotations: number
  unassignedConfirmed: number
  inDelivery: number
  uninvoicedCompleted: number
  pendingReturns: number
  lowStock: number
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function TodoCard({ count, label, desc, href, icon, warnAt = 1 }: {
  count: number | null; label: string; desc: string; href: string; icon: string; warnAt?: number
}) {
  const warn = count !== null && count >= warnAt
  return (
    <a
      href={href}
      className={`block bg-white rounded-xl border p-5 shadow-sm transition hover:shadow-md hover:-translate-y-0.5 ${
        warn ? 'border-amber-300' : 'border-gray-200'
      }`}
    >
      <div className="flex items-start justify-between">
        <span className="text-2xl">{icon}</span>
        {warn && (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">待处理</span>
        )}
      </div>
      <p className={`text-3xl font-bold mt-2 ${warn ? 'text-amber-600' : 'text-gray-900'}`}>
        {count === null ? '…' : count}
      </p>
      <p className="text-sm font-medium text-gray-800 mt-1">{label}</p>
      <p className="text-xs text-gray-400 mt-0.5">{desc} →</p>
    </a>
  )
}

export default function OperatorWorkbench() {
  const [counts, setCounts] = useState<WorkbenchCounts | null>(null)
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const p = `${prefix}/classic/operator`

  useEffect(() => {
    apiGet<WorkbenchCounts>(`/api/workbench?date=${todayStr()}`)
      .then(setCounts)
      .catch(() => {})
  }, [])

  const todayLabel = new Date().toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long',
  })
  const c = (k: keyof WorkbenchCounts) => (counts ? counts[k] : null)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">今日工作台</h1>
          <p className="text-sm text-gray-400 mt-0.5">{todayLabel} · 按业务流程排列,点击卡片直达</p>
        </div>
        <a
          href={`${p}/place-order`}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white shadow-sm"
          style={{ background: '#875A7B' }}
        >
          ＋ 代客下单
        </a>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <TodoCard icon="📝" count={c('pendingQuotations')} label="待确认报价单"
          desc="确认后进入拣货配送流程" href={`${p}/quotations`} />
        <TodoCard icon="🚦" count={c('unassignedConfirmed')} label="今日待分配订单"
          desc="去拣货波次分给司机" href={`${p}/waves`} />
        <TodoCard icon="🚚" count={c('inDelivery')} label="配送中订单"
          desc="查看配送行程进度" href={`${p}/trips`} warnAt={9999} />
        <TodoCard icon="🧾" count={c('uninvoicedCompleted')} label="已完成待开票"
          desc="去发票页批量生成" href={`${p}/invoices`} />
        <TodoCard icon="↩️" count={c('pendingReturns')} label="待审核退货"
          desc="审核司机上报的退换货" href={`${p}/returns`} />
        <TodoCard icon="📉" count={c('lowStock')} label="低库存商品"
          desc="库存不足 20,考虑补货" href={`${p}/purchases/suggestions`} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-3">业务流程速查</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {[
            ['下单', `${p}/place-order`],
            ['报价单确认', `${p}/quotations`],
            ['波次分配', `${p}/waves`],
            ['分货', `${p}/sorting`],
            ['配送', `${p}/trips`],
            ['开票', `${p}/invoices`],
            ['对账', `${prefix}/classic/finance/statements`],
          ].map(([label, href], i, arr) => (
            <span key={href} className="flex items-center gap-2">
              <a href={href} className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 hover:border-gray-400 text-gray-700">
                {label}
              </a>
              {i < arr.length - 1 && <span className="text-gray-300">→</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
