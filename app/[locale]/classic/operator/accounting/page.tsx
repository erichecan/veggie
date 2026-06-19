'use client'
import { useState } from 'react'
import InvoicesPage from '../invoices/page'
import VendorBillsPage from '../vendor-bills/page'

const PURPLE = '#875A7B'

type TabKey = 'invoices' | 'vendor-bills'

const TABS: { k: TabKey; icon: string; label: string }[] = [
  { k: 'invoices', icon: '🧾', label: '发票' },
  { k: 'vendor-bills', icon: '📄', label: '供应商账单' },
]

export default function AccountingPage() {
  const [tab, setTab] = useState<TabKey>('invoices')

  return (
    <div className="p-5 max-w-[1320px] mx-auto">
      {/* 页头 */}
      <div className="mb-4">
        <p className="text-xs text-gray-400">运营 / 会计</p>
        <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: PURPLE }}>
          🧮 会计
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
      {tab === 'invoices' && <InvoicesPage />}
      {tab === 'vendor-bills' && <VendorBillsPage />}
    </div>
  )
}
