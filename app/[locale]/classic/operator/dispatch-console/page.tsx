'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import DriversPage from '../drivers/page'
import BatchTab from './_components/BatchTab'
import DriverDispatchTab from './_components/DriverDispatchTab'

const BatchAnalysis = dynamic(() => import('@/components/shared/BatchAnalysis'), { ssr: false })

const PURPLE = '#875A7B'

type TabKey = 'waves' | 'dispatch' | 'trips' | 'config'

const TABS_ZH: { k: TabKey; icon: string; label: string }[] = [
  { k: 'waves', icon: '📦', label: '批次管理' },
  { k: 'dispatch', icon: '🧑‍✈️', label: '司机调度' },
  { k: 'trips', icon: '🗺️', label: '行程管理' },
  { k: 'config', icon: '⚙️', label: '司机配置' },
]

const TABS_EN: { k: TabKey; icon: string; label: string }[] = [
  { k: 'waves', icon: '📦', label: 'Batch Management' },
  { k: 'dispatch', icon: '🧑‍✈️', label: 'Driver Dispatch' },
  { k: 'trips', icon: '🗺️', label: 'Trip Management' },
  { k: 'config', icon: '⚙️', label: 'Driver Config' },
]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const TAB_KEYS: TabKey[] = ['waves', 'dispatch', 'trips', 'config']

function DispatchConsoleInner() {
  const searchParams = useSearchParams()
  // 20261001 客户反馈 #19：订单详情页的 Delivery 智能按钮要跳到"配送/拣货流程"，不是打印
  // 送货单——这俩 query 参数就是那条跳转链路：带着订单的交付日期 + 按订单状态算出来该停在
  // 哪个 tab(见 orders/[id]/page.tsx 的 deliveryConsoleTarget)，一进配送调度中心就直接
  // 看到这张订单对应的那一天/那个阶段，不用再手动翻日期、切 tab 去找。
  const initialTabParam = searchParams.get('tab')
  const initialTab: TabKey = TAB_KEYS.includes(initialTabParam as TabKey) ? (initialTabParam as TabKey) : 'waves'
  const initialDateParam = searchParams.get('date')
  const [tab, setTab] = useState<TabKey>(initialTab)
  const [date, setDate] = useState(initialDateParam && /^\d{4}-\d{2}-\d{2}$/.test(initialDateParam) ? initialDateParam : today)
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const TABS = isEn ? TABS_EN : TABS_ZH

  return (
    <div className="p-5 max-w-[1320px] mx-auto">
      {/* 页头（日期选择器已下移到批次管理工具栏） */}
      <div className="mb-4">
        <p className="text-xs text-gray-400">{isEn ? 'Sales / Dispatch Console' : '销售 / 配送调度中心'}</p>
        <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: PURPLE }}>
          🚚 {isEn ? 'Dispatch Console' : '配送调度中心'}
        </h1>
      </div>

      {/* Tab 条 */}
      <div className="flex gap-1 bg-white p-1.5 rounded-xl border mb-4" style={{ borderColor: '#e5e7eb' }}>
        {TABS.map(t => {
          const on = tab === t.k
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors"
              style={on ? { background: PURPLE, color: '#fff' } : { color: '#6b7280' }}
            >
              <span>{t.icon}</span>{t.label}
            </button>
          )
        })}
      </div>

      {/* Tab 内容 */}
      {tab === 'waves' && <BatchTab date={date} onPickDate={setDate} />}
      {tab === 'dispatch' && <DriverDispatchTab date={date} />}
      {tab === 'trips' && <BatchAnalysis />}
      {tab === 'config' && <DriversPage />}
    </div>
  )
}

export default function DispatchConsolePage() {
  return (
    <Suspense fallback={null}>
      <DispatchConsoleInner />
    </Suspense>
  )
}
