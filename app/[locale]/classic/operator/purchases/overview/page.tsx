'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { LineChart, Line, ResponsiveContainer } from 'recharts'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

interface KPIs {
  monthSpend: number
  monthSpendDeltaPct: number | null
  supplierUnpaidTotal: number
}

interface TopSupplierRow {
  supplierId: string
  supplierName: string
  amount: number
  topCategories: { label: string; amount: number }[]
}

interface RestockForecastItem {
  productId: string
  productName: string
  suggestedQty: number
  uomName: string | null
  priority: string
  trend: { day: string; qty: number }[]
}

interface GroupRow {
  key: string
  name: string
  nameZh: string
  cadence: string
  ownerName: string | null
  monthSpend: number
  pendingCount: number
  lastOrderDate: string | null
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

const CADENCE_LABEL: Record<string, string> = {
  DAILY: '每日自动',
  PERIODIC: '每周提醒',
  ANNUAL: '年度计划',
}

const SEVERITY_STYLE: Record<AttentionItem['severity'], { border: string; bg: string }> = {
  crit: { border: '#b6412a', bg: '#fdf1ee' },
  warn: { border: '#a3690e', bg: '#fbf3e6' },
  info: { border: '#35618a', bg: '#eef4fa' },
}

export default function ProcurementOverviewPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [kpis, setKpis] = useState<KPIs | null>(null)
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [topSuppliers, setTopSuppliers] = useState<TopSupplierRow[]>([])
  const [forecast, setForecast] = useState<RestockForecastItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet<{ kpis: KPIs; groups: GroupRow[]; attention: AttentionItem[]; topSuppliers: TopSupplierRow[]; forecast: RestockForecastItem[] }>(
      '/api/analytics/procurement-overview',
    )
      .then(d => {
        setKpis(d.kpis)
        setGroups(d.groups)
        setAttention(d.attention)
        setTopSuppliers(d.topSuppliers)
        setForecast(d.forecast)
      })
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
        <h1 className="text-xl font-bold text-gray-900">采购总览</h1>
        <p className="text-sm text-gray-500 mt-0.5">汇总四个品类里现在需要处理的事项 · 日常挑货/下单请进各自品类页面</p>
      </div>

      <div className="p-6 space-y-5">
        {/* KPI row */}
        <div className="bg-white rounded border border-gray-200 shadow-sm grid grid-cols-2 divide-x divide-gray-200">
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />本月采购支出
            </div>
            <div className="text-lg font-bold text-gray-900">{eur(kpis?.monthSpend ?? 0)}</div>
            {kpis?.monthSpendDeltaPct != null && (
              <div className="text-xs text-gray-400 mt-0.5">较上月 {kpis.monthSpendDeltaPct >= 0 ? '+' : ''}{kpis.monthSpendDeltaPct}%</div>
            )}
          </div>
          <div className="p-4">
            <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#a3690e' }} />供应商未付款
            </div>
            <div className="text-lg font-bold" style={{ color: '#a3690e' }}>{eur(kpis?.supplierUnpaidTotal ?? 0)}</div>
            <div className="text-xs text-gray-400 mt-0.5">全部未结清应付账款</div>
          </div>
        </div>

        {/* Restock forecast — 复用现有建议引擎，换个展示位 */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">建议关注的补货商品</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            {forecast.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">暂无补货建议</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-x divide-y sm:divide-y-0 divide-gray-100">
                {forecast.map(item => (
                  <div
                    key={item.productId}
                    onClick={() => go('/classic/operator/purchases/new')}
                    className="p-3 cursor-pointer hover:bg-gray-50 flex items-center gap-3"
                  >
                    <div style={{ width: 64, height: 32 }}>
                      <ResponsiveContainer>
                        <LineChart data={item.trend}>
                          <Line type="monotone" dataKey="qty" stroke={PURPLE} strokeWidth={1.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 truncate">{item.productName}</div>
                      <div className="text-xs text-gray-500">建议采购 {item.suggestedQty}{item.uomName ?? ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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

        {/* Top10 suppliers */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Top10 供应商 · 近12个月</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            {topSuppliers.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">近12个月暂无采购记录</div>
            ) : (
              <>
                <div className="grid grid-cols-[28px_1.4fr_1fr_2fr] px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
                  <div>#</div><div>供应商</div><div>采购金额</div><div>主要品类</div>
                </div>
                {topSuppliers.map((s, i) => (
                  <div key={s.supplierId} className="grid grid-cols-[28px_1.4fr_1fr_2fr] px-4 py-2.5 items-center border-b border-gray-100 last:border-b-0 text-sm">
                    <div className="text-gray-400">{i + 1}</div>
                    <div className="text-gray-800">{s.supplierName}</div>
                    <div className="font-medium" style={{ color: PURPLE }}>{eur(s.amount)}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {s.topCategories.map(c => `${c.label} ${eur(c.amount)}`).join(' · ') || '—'}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Category status table */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">四个品类现状</h2>
          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr_1.2fr] px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
              <div>品类</div><div>本月采购额</div><div>待处理</div><div>节奏</div><div>最近下单</div>
            </div>
            {groups.map(g => (
              <div key={g.key} className="grid grid-cols-[1.6fr_1fr_1fr_1fr_1.2fr] px-4 py-3 items-center border-b border-gray-100 last:border-b-0 text-sm">
                <div className="flex items-center gap-2">
                  <span>{{ FRESH_FROZEN: '🥬', SUPERMARKET: '🛒', JAPANESE_KOREAN: '🍱', DRY_GOODS: '🌾' }[g.key] ?? '📦'}</span>
                  <span className="text-gray-800">{g.nameZh}</span>
                  <span className="text-xs text-gray-400">· {g.ownerName ?? '未指定负责人'}</span>
                </div>
                <div className="text-gray-700">{eur(g.monthSpend)}</div>
                <div className="font-semibold" style={{ color: g.pendingCount > 0 ? '#b6412a' : '#9ca3af' }}>{g.pendingCount}</div>
                <div className="text-gray-600 text-xs">{CADENCE_LABEL[g.cadence] ?? g.cadence}</div>
                <div className="text-gray-600 text-xs">{g.lastOrderDate ? formatDateOnly(g.lastOrderDate) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
