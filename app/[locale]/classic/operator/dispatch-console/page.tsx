'use client'
import { useState } from 'react'
import dynamic from 'next/dynamic'
import DriversPage from '../drivers/page'
import BatchTab from './_components/BatchTab'
import DriverDispatchTab from './_components/DriverDispatchTab'

const BatchAnalysis = dynamic(() => import('@/components/shared/BatchAnalysis'), { ssr: false })

const PURPLE = '#875A7B'

type TabKey = 'waves' | 'dispatch' | 'trips' | 'config'

const TABS: { k: TabKey; icon: string; label: string }[] = [
  { k: 'waves', icon: '📦', label: '批次管理' },
  { k: 'dispatch', icon: '🧑‍✈️', label: '司机调度' },
  { k: 'trips', icon: '🗺️', label: '行程管理' },
  { k: 'config', icon: '⚙️', label: '司机配置' },
]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function DispatchConsolePage() {
  const [tab, setTab] = useState<TabKey>('waves')
  const [date, setDate] = useState(today)

  return (
    <div className="p-5 max-w-[1320px] mx-auto">
      {/* 页头 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs text-gray-400">销售 / 配送调度中心</p>
          <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: PURPLE }}>
            🚚 配送调度中心
          </h1>
        </div>
        <label className="flex items-center gap-2 bg-white border rounded-lg px-3 py-1.5 text-sm" style={{ borderColor: '#e5e7eb' }}>
          📅
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="outline-none text-sm"
          />
        </label>
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
