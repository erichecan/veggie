'use client'
import { useState } from 'react'
import PrintCenter from './_components/PrintCenter'
import ShortageHandler from './_components/ShortageHandler'
import SalesStats from './_components/SalesStats'

type Tab = 'print' | 'shortage' | 'stats'

export default function DailySalesPage() {
  const [tab, setTab] = useState<Tab>('print')

  const tabCls = (t: Tab) =>
    `px-5 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
      tab === t
        ? 'border-[#875A7B] text-[#875A7B]'
        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
    }`

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="px-6 pt-5 pb-0">
          <h1 className="text-lg font-semibold text-gray-900 mb-3">日销售管理中心</h1>
          <div className="flex">
            <button className={tabCls('print')} onClick={() => setTab('print')}>打印中心</button>
            <button className={tabCls('shortage')} onClick={() => setTab('shortage')}>缺货处理</button>
            <button className={tabCls('stats')} onClick={() => setTab('stats')}>销售统计</button>
          </div>
        </div>
      </div>
      <div className="px-6 py-6">
        {tab === 'print' && <PrintCenter />}
        {tab === 'shortage' && <ShortageHandler />}
        {tab === 'stats' && <SalesStats />}
      </div>
    </div>
  )
}
