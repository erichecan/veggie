'use client'
import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import InventoryOverviewPage from './overview/page'
import ReceivePage from './receive/page'
import ClassicReturnsPage from '../returns/page'

const PURPLE = '#875A7B'

// 20260821：损耗与退货/批次台账·追溯/仓库地图·温区 三个 tab 已按范围确认仅做 UI 入口下线，
// 底层页面文件/API/数据模型保留不动。退换货则从顶部导航迁入本页新增的 returns tab。
type TabKey = 'overview' | 'receive' | 'returns'

const ANALYTICS_TABS_ZH: { k: TabKey; icon: string; label: string }[] = [
  { k: 'overview', icon: '📊', label: '库存总览' },
  { k: 'receive', icon: '📥', label: '收货' },
  { k: 'returns', icon: '↩️', label: '退换货' },
]

const ANALYTICS_TABS_EN: { k: TabKey; icon: string; label: string }[] = [
  { k: 'overview', icon: '📊', label: 'Overview' },
  { k: 'receive', icon: '📥', label: 'Receiving' },
  { k: 'returns', icon: '↩️', label: 'Returns' },
]

function InventoryPageInner() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const ANALYTICS_TABS = isEn ? ANALYTICS_TABS_EN : ANALYTICS_TABS_ZH
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
      {tab === 'returns' && <ClassicReturnsPage />}
    </div>
  )
}

export default function InventoryPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  return (
    <Suspense fallback={<div className="p-5 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>}>
      <InventoryPageInner />
    </Suspense>
  )
}
