'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import PrintCenter from './_components/PrintCenter'
import ShortageHandler from './_components/ShortageHandler'
import SalesStats from './_components/SalesStats'

type Tab = 'print' | 'shortage' | 'stats'

export default function DailySalesPage() {
  const [tab, setTab] = useState<Tab>('print')
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  // 页头统一刷新：递增 refreshKey → 当前挂载的 Tab 重新拉取数据（保留其日期/筛选）
  const [refreshKey, setRefreshKey] = useState(0)

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
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold text-gray-900">{isEn ? 'Daily Sales Center' : '日销售管理中心'}</h1>
            {tab !== 'print' && (
              <button
                onClick={() => setRefreshKey(k => k + 1)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
                style={{ background: '#875A7B' }}
                title={isEn ? 'Refetch data for the current tab' : '重新拉取当前标签页的数据'}
              >
                🔄 {isEn ? 'Refresh' : '刷新'}
              </button>
            )}
          </div>
          <div className="flex">
            <button className={tabCls('print')} onClick={() => setTab('print')}>{isEn ? 'Print Center' : '打印中心'}</button>
            <button className={tabCls('shortage')} onClick={() => setTab('shortage')}>{isEn ? 'Shortage Handling' : '缺货处理'}</button>
            <button className={tabCls('stats')} onClick={() => setTab('stats')}>{isEn ? 'Sales Stats' : '销售统计'}</button>
          </div>
        </div>
      </div>
      <div className="px-6 py-6">
        {tab === 'print' && <PrintCenter refreshKey={refreshKey} onRefresh={() => setRefreshKey(k => k + 1)} />}
        {tab === 'shortage' && <ShortageHandler refreshKey={refreshKey} />}
        {tab === 'stats' && <SalesStats refreshKey={refreshKey} />}
      </div>
    </div>
  )
}
