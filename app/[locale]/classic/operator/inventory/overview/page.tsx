'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { formatDateOnly } from '@/lib/format-date'
import StockMovesTable from '@/components/classic/StockMovesTable'

const PURPLE = '#875A7B'

type DetailTab = 'ATTENTION' | 'EXPIRING' | 'LOSS' | 'STOCKTAKE'

interface KPIs {
  totalStockValue: number
  expiringLotCount: number
  monthLossRate: number
  pendingStockTakeCount: number
}

interface ExpiringLotRow {
  id: string
  lotNumber: string
  currentQty: string | number
  bestBefore: string
  isExpired: boolean
  daysRemaining: number
  product?: { name: string; spec?: string | null }
}

interface DraftStockTake {
  id: string
  status: string
  takenAt: string
  notes?: string | null
  _count?: { lines: number }
}

interface AttentionItem {
  severity: 'crit' | 'warn' | 'info'
  categoryLabel: string
  icon: string
  title: string
  desc: string
  actionLabel: string
  actionHref: string
}

interface GroupRow {
  groupKey: string
  groupName: string
  groupNameZh: string
  skuCount: number
  totalValue: number
  lowStockCount: number
}

const GROUP_ICON: Record<string, string> = {
  FRESH_FROZEN: '🥬',
  SUPERMARKET: '🛒',
  JAPANESE_KOREAN: '🍱',
  DRY_GOODS: '🌾',
  UNGROUPED: '📦',
}

const SEVERITY_STYLE: Record<AttentionItem['severity'], { border: string; bg: string }> = {
  crit: { border: '#b6412a', bg: '#fdf1ee' },
  warn: { border: '#a3690e', bg: '#fbf3e6' },
  info: { border: '#35618a', bg: '#eef4fa' },
}

export default function InventoryOverviewPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [kpis, setKpis] = useState<KPIs | null>(null)
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(true)

  // 20261016：三张 KPI 卡片点击后不再跳页，改为在本页切换下方明细面板（客户反馈：点一下就跳走太重）
  const [activeTab, setActiveTab] = useState<DetailTab>('ATTENTION')
  const [expiringLots, setExpiringLots] = useState<ExpiringLotRow[] | null>(null)
  const [expiringLoading, setExpiringLoading] = useState(false)
  const [stockTakes, setStockTakes] = useState<DraftStockTake[] | null>(null)
  const [stockTakeLoading, setStockTakeLoading] = useState(false)

  useEffect(() => {
    apiGet<{ kpis: KPIs; attention: AttentionItem[]; groups: GroupRow[] }>(`/api/analytics/inventory-overview?locale=${locale}`)
      .then(d => { setKpis(d.kpis); setAttention(d.attention); setGroups(d.groups) })
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
      .finally(() => setLoading(false))
  }, [locale, isEn])

  useEffect(() => {
    if (activeTab === 'EXPIRING' && expiringLots === null) {
      setExpiringLoading(true)
      apiGet<ExpiringLotRow[]>('/api/lots/expiring?days=7&limit=200')
        .then(setExpiringLots)
        .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
        .finally(() => setExpiringLoading(false))
    }
    if (activeTab === 'STOCKTAKE' && stockTakes === null) {
      setStockTakeLoading(true)
      apiGet<{ items: DraftStockTake[] }>('/api/stock-takes?status=DRAFT&limit=50')
        .then(d => setStockTakes(d.items))
        .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
        .finally(() => setStockTakeLoading(false))
    }
  }, [activeTab, expiringLots, stockTakes, isEn])

  function go(href: string) {
    router.push(`${prefix}${href}`)
  }

  function toggleTab(tab: Exclude<DetailTab, 'ATTENTION'>) {
    setActiveTab(prev => (prev === tab ? 'ATTENTION' : tab))
  }

  // 本地年月日拼接，避免 toISOString() 按 UTC 转换导致都柏林时区下早一天
  function ymd(d: Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const todayYMD = ymd(today)
  const monthStartYMD = ymd(monthStart)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
          <button onClick={() => go('/classic/operator/inventory')} className="hover:underline">
            {isEn ? 'Inventory Management' : '库存管理'}
          </button>
          <span>/</span>
          <span style={{ color: PURPLE }}>{isEn ? 'Inventory Overview' : '库存总览'}</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900">{isEn ? 'Inventory Overview' : '库存总览'}</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {isEn
            ? 'All stock assets, expiry risk, and loss rate at a glance · go to the respective sub-page for specific actions'
            : '全库存资产、临期风险与损耗口径一屏掌握 · 具体操作请进各自子页面'}
        </p>
      </div>

      <div className="p-6 space-y-5">
        {/* KPI row */}
        <div className="bg-white rounded border border-gray-200 shadow-sm grid grid-cols-4 divide-x divide-gray-200">
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />{isEn ? 'Total Stock Value' : '库存总值'}
            </div>
            <div className="text-lg font-bold text-gray-900">{eur(kpis?.totalStockValue ?? 0)}</div>
            <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'On-shelf products × cost price' : '在架商品 × 成本价'}</div>
          </div>
          <div
            className="p-4 cursor-pointer hover:bg-gray-50"
            onClick={() => toggleTab('EXPIRING')}
            style={activeTab === 'EXPIRING' ? { background: '#fbf3e6', boxShadow: 'inset 0 -3px 0 #a3690e' } : undefined}
          >
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#a3690e' }} />{isEn ? 'Expiring Lots' : '临期批次'}
            </div>
            <div className="text-lg font-bold" style={{ color: '#a3690e' }}>{kpis?.expiringLotCount ?? 0}</div>
            <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'Due within 7 days (incl. expired)' : '7 天内到期（含已过期）'}</div>
          </div>
          <div
            className="p-4 cursor-pointer hover:bg-gray-50"
            onClick={() => toggleTab('LOSS')}
            style={activeTab === 'LOSS' ? { background: '#fdf1ee', boxShadow: 'inset 0 -3px 0 #b6412a' } : undefined}
          >
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#b6412a' }} />{isEn ? "This Month's Loss Rate" : '本月损耗率'}
            </div>
            <div className="text-lg font-bold" style={{ color: '#b6412a' }}>{kpis?.monthLossRate ?? 0}%</div>
            <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'Scrapped qty / outbound qty' : '报废数量 / 出库数量'}</div>
          </div>
          <div
            className="p-4 cursor-pointer hover:bg-gray-50"
            onClick={() => toggleTab('STOCKTAKE')}
            style={activeTab === 'STOCKTAKE' ? { background: '#eef4fa', boxShadow: 'inset 0 -3px 0 #35618a' } : undefined}
          >
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#35618a' }} />{isEn ? 'Pending Stock Takes' : '待完成盘点'}
            </div>
            <div className="text-lg font-bold" style={{ color: '#35618a' }}>{kpis?.pendingStockTakeCount ?? 0}</div>
            <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'Draft status' : '草稿状态'}</div>
          </div>
        </div>

        {/* Detail panel：默认显示「需要关注」，点上面三张 KPI 卡片切到对应明细，不离开本页；再点一次切回默认 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {activeTab === 'ATTENTION' && (isEn ? 'Needs Attention' : '需要关注')}
              {activeTab === 'EXPIRING' && (isEn ? 'Expiring Lots (within 7 days)' : '临期批次（7 天内）')}
              {activeTab === 'LOSS' && (isEn ? "This Month's Scrap Moves" : '本月报废流水')}
              {activeTab === 'STOCKTAKE' && (isEn ? 'Pending Stock Takes' : '待完成盘点')}
            </h2>
            {activeTab !== 'ATTENTION' && (
              <button onClick={() => setActiveTab('ATTENTION')} className="text-xs hover:underline" style={{ color: PURPLE }}>
                {isEn ? '← Back to Needs Attention' : '← 返回需要关注'}
              </button>
            )}
          </div>

          {activeTab === 'ATTENTION' && (
            <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
              {attention.length === 0 ? (
                <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'Nothing needs attention right now' : '暂时没有需要关注的事项'}</div>
              ) : (
                attention.map((item, i) => {
                  const style = SEVERITY_STYLE[item.severity]
                  return (
                    <div
                      key={i}
                      onClick={() => go(item.actionHref)}
                      className="grid grid-cols-[26px_1fr_auto] gap-3 items-center px-4 py-3 border-b border-gray-100 last:border-b-0 cursor-pointer hover:bg-gray-50"
                      style={{ borderLeft: `3px solid ${style.border}` }}
                    >
                      <span className="text-lg text-center">{item.icon}</span>
                      <div>
                        <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1.5">{item.categoryLabel}</span>
                        <span className="font-semibold text-gray-800 text-sm">{item.title}</span>
                        <div className="text-xs text-gray-500 mt-0.5">{item.desc}</div>
                      </div>
                      <span className="text-xs font-semibold whitespace-nowrap" style={{ color: PURPLE }}>{item.actionLabel}</span>
                    </div>
                  )
                })
              )}
            </div>
          )}

          {activeTab === 'EXPIRING' && (
            <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
              <div className="grid grid-cols-[1.4fr_120px_90px_120px_110px] gap-2 px-4 py-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
                <span>{isEn ? 'Product' : '商品'}</span>
                <span>{isEn ? 'Lot #' : '批号'}</span>
                <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
                <span>{isEn ? 'Best Before' : '保质期'}</span>
                <span>{isEn ? 'Status' : '状态'}</span>
              </div>
              {expiringLoading && <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>}
              {!expiringLoading && (expiringLots?.length ?? 0) === 0 && (
                <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'No expiring lots' : '暂无临期批次'}</div>
              )}
              {!expiringLoading && expiringLots?.map(lot => (
                <div key={lot.id} className="grid grid-cols-[1.4fr_120px_90px_120px_110px] gap-2 px-4 py-2.5 items-center border-b border-gray-100 last:border-b-0 text-sm">
                  <span className="text-gray-800">
                    {lot.product?.name ?? (isEn ? 'Unknown product' : '未知商品')}
                    {lot.product?.spec && <span className="ml-1 text-xs text-gray-400">({lot.product.spec})</span>}
                  </span>
                  <span className="text-xs font-mono text-gray-600">{lot.lotNumber}</span>
                  <span className="text-xs font-mono text-right">{Number(lot.currentQty).toFixed(2)}</span>
                  <span className="text-xs text-gray-600">{formatDateOnly(lot.bestBefore)}</span>
                  {lot.isExpired
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium w-fit">{isEn ? `Expired ${Math.abs(lot.daysRemaining)}d ago` : `已过期 ${Math.abs(lot.daysRemaining)} 天`}</span>
                    : <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium w-fit">{isEn ? `${lot.daysRemaining}d left` : `剩 ${lot.daysRemaining} 天`}</span>}
                </div>
              ))}
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                <button onClick={() => go('/classic/operator/inventory/lots?expiring=1')} className="text-xs hover:underline" style={{ color: PURPLE }}>
                  {isEn ? 'Open full lot ledger →' : '前往批次台账完整页面 →'}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'LOSS' && (
            <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden p-3">
              <StockMovesTable
                filter={{ type: 'SCRAP', from: monthStartYMD, to: todayYMD }}
                isEn={isEn}
                pageSize={10}
                emptyText={isEn ? 'No scrap moves this month' : '本月暂无报废流水'}
              />
              <div className="pt-2 mt-2 border-t border-gray-100">
                <button onClick={() => go(`/classic/operator/inventory/moves?type=SCRAP&from=${monthStartYMD}&to=${todayYMD}`)} className="text-xs hover:underline" style={{ color: PURPLE }}>
                  {isEn ? 'Open full stock moves page →' : '前往库存流水完整页面 →'}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'STOCKTAKE' && (
            <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
              {stockTakeLoading && <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>}
              {!stockTakeLoading && (stockTakes?.length ?? 0) === 0 && (
                <div className="py-10 text-center text-gray-400 text-sm">{isEn ? 'No pending stock takes' : '暂无待完成盘点'}</div>
              )}
              {!stockTakeLoading && stockTakes?.map(st => (
                <div key={st.id} className="grid grid-cols-[120px_80px_1fr] gap-3 items-center px-4 py-2.5 border-b border-gray-100 last:border-b-0 text-sm">
                  <span className="text-gray-600">{formatDateOnly(st.takenAt)}</span>
                  <span className="text-gray-700">{st._count?.lines ?? '—'} {isEn ? 'items' : '项'}</span>
                  <span className="text-xs text-gray-400 truncate">{st.notes ?? '—'}</span>
                </div>
              ))}
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                <button onClick={() => go('/classic/warehouse/stock-take?status=DRAFT')} className="text-xs hover:underline" style={{ color: PURPLE }}>
                  {isEn ? 'Open stock take page to process →' : '前往盘点页面处理 →'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Category group table */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{isEn ? 'By Category' : '按品类分组'}</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
              <div>{isEn ? 'Category' : '品类'}</div><div>{isEn ? 'SKU Count' : 'SKU 数'}</div><div>{isEn ? 'Stock Value' : '库存总值'}</div><div>{isEn ? 'Low Stock Alerts' : '低库存预警'}</div>
            </div>
            {groups.map(g => (
              <div key={g.groupKey} className="grid grid-cols-[1.6fr_1fr_1fr_1fr] px-4 py-3 items-center border-b border-gray-100 last:border-b-0 text-sm">
                <div className="flex items-center gap-2">
                  <span>{GROUP_ICON[g.groupKey] ?? '📦'}</span>
                  <span className="text-gray-800">{isEn ? g.groupName : g.groupNameZh}</span>
                </div>
                <div className="text-gray-700">{g.skuCount}</div>
                <div className="text-gray-700">{eur(g.totalValue)}</div>
                <div className="font-semibold" style={{ color: g.lowStockCount > 0 ? '#b6412a' : '#9ca3af' }}>{g.lowStockCount}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
