'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

interface KPIs {
  totalStockValue: number
  expiringLotCount: number
  monthLossRate: number
  pendingStockTakeCount: number
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

  const [kpis, setKpis] = useState<KPIs | null>(null)
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet<{ kpis: KPIs; attention: AttentionItem[]; groups: GroupRow[] }>('/api/analytics/inventory-overview')
      .then(d => { setKpis(d.kpis); setAttention(d.attention); setGroups(d.groups) })
      .catch(e => toast.error(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  function go(href: string) {
    router.push(`${prefix}${href}`)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        加载中...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
          <button onClick={() => go('/classic/operator/inventory')} className="hover:underline">
            库存管理
          </button>
          <span>/</span>
          <span style={{ color: PURPLE }}>库存总览</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900">库存总览</h1>
        <p className="text-sm text-gray-500 mt-0.5">全库存资产、临期风险与损耗口径一屏掌握 · 具体操作请进各自子页面</p>
      </div>

      <div className="p-6 space-y-5">
        {/* KPI row */}
        <div className="bg-white rounded border border-gray-200 shadow-sm grid grid-cols-4 divide-x divide-gray-200">
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />库存总值
            </div>
            <div className="text-lg font-bold text-gray-900">{eur(kpis?.totalStockValue ?? 0)}</div>
            <div className="text-xs text-gray-400 mt-0.5">在架商品 × 成本价</div>
          </div>
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#a3690e' }} />临期批次
            </div>
            <div className="text-lg font-bold" style={{ color: '#a3690e' }}>{kpis?.expiringLotCount ?? 0}</div>
            <div className="text-xs text-gray-400 mt-0.5">3 天内到期（含已过期）</div>
          </div>
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#b6412a' }} />本月损耗率
            </div>
            <div className="text-lg font-bold" style={{ color: '#b6412a' }}>{kpis?.monthLossRate ?? 0}%</div>
            <div className="text-xs text-gray-400 mt-0.5">报废数量 / 出库数量</div>
          </div>
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#35618a' }} />待完成盘点
            </div>
            <div className="text-lg font-bold" style={{ color: '#35618a' }}>{kpis?.pendingStockTakeCount ?? 0}</div>
            <div className="text-xs text-gray-400 mt-0.5">草稿状态</div>
          </div>
        </div>

        {/* Attention list */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">需要关注</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            {attention.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">暂时没有需要关注的事项</div>
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
        </div>

        {/* Category group table */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">按品类分组</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
              <div>品类</div><div>SKU 数</div><div>库存总值</div><div>低库存预警</div>
            </div>
            {groups.map(g => (
              <div key={g.groupKey} className="grid grid-cols-[1.6fr_1fr_1fr_1fr] px-4 py-3 items-center border-b border-gray-100 last:border-b-0 text-sm">
                <div className="flex items-center gap-2">
                  <span>{GROUP_ICON[g.groupKey] ?? '📦'}</span>
                  <span className="text-gray-800">{g.groupNameZh}</span>
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
