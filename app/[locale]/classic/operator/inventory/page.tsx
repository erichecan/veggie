'use client'
import { useState } from 'react'
import InventoryOverviewPage from './overview/page'
import LotsPage from './lots/page'
import ZoneInventoryPage from './zones/page'
import LossDashboardPage from './loss-dashboard/page'

const PURPLE = '#875A7B'

type TabKey = 'overview' | 'lots' | 'zones' | 'loss-dashboard'

const ANALYTICS_TABS: { k: TabKey; icon: string; label: string }[] = [
  { k: 'overview', icon: '📊', label: '库存总览' },
  { k: 'lots', icon: '📑', label: '批次台账／追溯' },
  { k: 'zones', icon: '🧊', label: '仓库地图·温区' },
  { k: 'loss-dashboard', icon: '📉', label: '损耗与退货' },
]

export default function InventoryPage() {
  const [tab, setTab] = useState<TabKey>('overview')

  return (
    <div className="p-5 max-w-[1320px] mx-auto">
      {/* 分析入口（同页切换，不跳转） */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {ANALYTICS_TABS.map(l => {
          const on = tab === l.k
          return (
            <button
              key={l.k}
              onClick={() => setTab(l.k)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border bg-white hover:shadow-sm transition-all"
              style={on ? { borderColor: PURPLE, color: PURPLE, background: '#f3eff5' } : { borderColor: '#e5e7eb', color: '#6b7280' }}
            >
              <span>{l.icon}</span>{l.label}
            </button>
          )
        })}
      </div>

      {/* Tab 内容（直接嵌入对应子页，进来即实操界面） */}
      {tab === 'overview' && <InventoryOverviewPage />}
      {tab === 'lots' && <LotsPage />}
      {tab === 'zones' && <ZoneInventoryPage />}
      {tab === 'loss-dashboard' && <LossDashboardPage />}
    </div>
  )
}
