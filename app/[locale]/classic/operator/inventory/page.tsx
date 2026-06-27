'use client'
import { useState } from 'react'
import SuggestionsPage from '../purchases/suggestions/page'
import ReceiptsPage from './receipts/page'
import AdjustmentsPage from './adjustments/page'
import ScrapPage from './scrap/page'
import DiscrepanciesPage from './discrepancies/page'

const PURPLE = '#875A7B'

type TabKey = 'suggestions' | 'flow' | 'receipts' | 'scrap' | 'discrepancies'

const TABS: { k: TabKey; icon: string; label: string }[] = [
  { k: 'suggestions', icon: '🛒', label: '采购建议' },
  { k: 'flow', icon: '📋', label: '库存流水' },
  { k: 'receipts', icon: '📦', label: '收货入库' },
  { k: 'scrap', icon: '🗑️', label: '报废管理' },
  { k: 'discrepancies', icon: '⚠️', label: '拣货差异' },
]

export default function InventoryPage() {
  const [tab, setTab] = useState<TabKey>('suggestions')

  return (
    <div className="p-5 max-w-[1320px] mx-auto">
      {/* 页头 */}
      <div className="mb-4">
        <p className="text-xs text-gray-400">销售 / 库存管理</p>
        <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: PURPLE }}>
          📦 库存管理
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

      {/* Tab 内容（直接嵌入对应子页，进来即实操界面） */}
      {tab === 'suggestions' && <SuggestionsPage />}
      {tab === 'flow' && <AdjustmentsPage />}
      {tab === 'receipts' && <ReceiptsPage />}
      {tab === 'scrap' && <ScrapPage />}
      {tab === 'discrepancies' && <DiscrepanciesPage />}
    </div>
  )
}
