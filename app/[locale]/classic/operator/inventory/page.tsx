'use client'
import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import InventoryOverviewPage from './overview/page'
import ReceivePage from './receive/page'
import LotsPage from './lots/page'
import ZoneInventoryPage from './zones/page'
import LossDashboardPage from './loss-dashboard/page'

const PURPLE = '#875A7B'

type TabKey = 'overview' | 'receive' | 'lots' | 'zones' | 'loss-dashboard'

const ANALYTICS_TABS: { k: TabKey; icon: string; label: string }[] = [
  { k: 'overview', icon: '📊', label: '库存总览' },
  { k: 'receive', icon: '📥', label: '收货' },
  { k: 'lots', icon: '📑', label: '批次台账／追溯' },
  { k: 'zones', icon: '🧊', label: '仓库地图·温区' },
  { k: 'loss-dashboard', icon: '📉', label: '损耗与退货' },
]

function InventoryPageInner() {
  const searchParams = useSearchParams()
  const initialTab = (searchParams.get('tab') as TabKey | null) ?? 'overview'
  const [tab, setTab] = useState<TabKey>(ANALYTICS_TABS.some(t => t.k === initialTab) ? initialTab : 'overview')

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
      {tab === 'receive' && <ReceivePage />}
      {tab === 'lots' && <LotsPage />}
      {tab === 'zones' && <ZoneInventoryPage />}
      {tab === 'loss-dashboard' && <LossDashboardPage />}
    </div>
  )
}

export default function InventoryPage() {
  return (
    <Suspense fallback={<div className="p-5 text-center text-gray-400 text-sm">加载中...</div>}>
      <InventoryPageInner />
    </Suspense>
  )
}
