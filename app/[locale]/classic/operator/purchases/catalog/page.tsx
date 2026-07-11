'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'
const REMIND_AFTER_DAYS = 7

type GroupKey = 'SUPERMARKET' | 'JAPANESE_KOREAN'

const GROUPS: Array<{ key: GroupKey; icon: string }> = [
  { key: 'SUPERMARKET', icon: '🛒' },
  { key: 'JAPANESE_KOREAN', icon: '🍱' },
]

const GROUP_LABEL_ZH: Record<GroupKey, string> = {
  SUPERMARKET: '超市商品',
  JAPANESE_KOREAN: '日韩商品',
}
const GROUP_LABEL_EN: Record<GroupKey, string> = {
  SUPERMARKET: 'Supermarket',
  JAPANESE_KOREAN: 'Japanese/Korean',
}

interface Supplier { id: string; name: string }

interface ParsedLine {
  rawProductName: string
  quantity: number
  unitCost: number
  matchedProductId: string | null
  matchedProductName: string | null
  confidence: 'exact' | 'fuzzy' | 'none'
}

interface PriceTrend {
  latestCost: number
  prevCost: number | null
  changePct: number | null
  recentCosts: number[]
}

function Sparkline({ costs }: { costs: number[] }) {
  if (costs.length < 2) return <span className="text-gray-300 text-xs">—</span>
  const min = Math.min(...costs)
  const max = Math.max(...costs)
  const range = max - min
  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height: 22 }}>
      {costs.map((c, i) => {
        const pct = range > 0 ? (c - min) / range : 0.5
        const h = Math.round(6 + pct * 16)
        return (
          <i
            key={i}
            style={{
              display: 'block',
              width: 4,
              height: h,
              background: '#35618a',
              opacity: i === costs.length - 1 ? 1 : 0.55,
              borderRadius: '1px 1px 0 0',
            }}
          />
        )
      })}
    </span>
  )
}

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86400000)
}

export default function CatalogPickingPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const GROUP_LABEL = isEn ? GROUP_LABEL_EN : GROUP_LABEL_ZH

  const [activeGroup, setActiveGroup] = useState<GroupKey>('SUPERMARKET')
  const [lastByGroup, setLastByGroup] = useState<Record<string, string | null>>({})
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{
    stats: { total: number; exactMatch: number; fuzzyMatch: number; noMatch: number }
    lines: ParsedLine[]
    createdPO: { id: string; name: string } | null
  } | null>(null)
  const [trends, setTrends] = useState<Record<string, PriceTrend>>({})

  const loadLastByGroup = useCallback(() => {
    apiGet<Record<string, string | null>>('/api/purchase-orders/last-by-group')
      .then(setLastByGroup)
      .catch(() => {})
  }, [])

  useEffect(() => { loadLastByGroup() }, [loadLastByGroup])
  useEffect(() => {
    apiGet<{ items: Supplier[] }>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(d.items ?? (d as unknown as Supplier[])))
      .catch(() => {})
  }, [])

  function switchGroup(g: GroupKey) {
    setActiveGroup(g)
    setResult(null)
    setFile(null)
    setSupplierId('')
    setTrends({})
  }

  async function handleImport() {
    if (!supplierId) { toast.error(isEn ? 'Please select a supplier' : '请选择供应商'); return }
    if (!file) { toast.error(isEn ? 'Please select a file' : '请选择文件'); return }
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('supplierId', supplierId)
      const token = localStorage.getItem('veggie_token')
      const res = await fetch('/api/purchase-orders/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResult(data)
      if (data.createdPO) {
        toast.success(isEn ? `Created purchase order draft ${data.createdPO.name}` : `已创建采购单草稿 ${data.createdPO.name}`)
        loadLastByGroup()
      }
      const ids = (data.lines as ParsedLine[]).map(l => l.matchedProductId).filter(Boolean) as string[]
      if (ids.length > 0) {
        apiGet<Record<string, PriceTrend>>(`/api/analytics/price-trends?productIds=${ids.join(',')}`)
          .then(setTrends)
          .catch(() => {})
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    } finally {
      setImporting(false)
    }
  }

  const lastDateStr = lastByGroup[activeGroup]
  const lastDate = lastDateStr ? new Date(lastDateStr) : null
  const overdue = !lastDate || daysSince(lastDate) > REMIND_AFTER_DAYS

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="text-xs text-gray-500 mb-1">
          <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)} className="hover:underline" style={{ color: PURPLE }}>{isEn ? 'Purchases' : '采购'}</button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">{isEn ? 'Catalog Picking' : '目录挑选'}</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900">{GROUPS.find(g => g.key === activeGroup)?.icon} {isEn ? 'Catalog Picking' : '目录挑选'}</h1>
        <div className="flex gap-2 mt-3">
          {GROUPS.map(g => (
            <button
              key={g.key}
              onClick={() => switchGroup(g.key)}
              className="px-3 py-1.5 rounded text-sm font-semibold"
              style={{
                background: activeGroup === g.key ? PURPLE : '#e8e6df',
                color: activeGroup === g.key ? '#fff' : '#6b7280',
              }}
            >
              {g.icon} {GROUP_LABEL[g.key]}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        <div
          className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded text-sm"
          style={overdue ? { background: '#f4e7cf', color: '#a3690e' } : { background: '#e5f1e9', color: '#2e7d4f' }}
        >
          {overdue ? '📅' : '✓'} {lastDate
            ? (isEn
              ? `Last ordered ${formatDateOnly(lastDate.toISOString())} (${daysSince(lastDate)} days ago)`
              : `上次下单 ${formatDateOnly(lastDate.toISOString())}（${daysSince(lastDate)} 天前）`)
            : (isEn ? 'No purchase history for this category yet' : '还没有该品类的历史采购记录')}
          {overdue
            ? (isEn ? ` · Over ${REMIND_AFTER_DAYS} days since last order, time to restock this week` : ` · 已超过 ${REMIND_AFTER_DAYS} 天未下单，本周该盘货了`)
            : (isEn ? ' · Within the weekly cadence, no restock needed yet' : ' · 未超过每周节奏，暂不需要盘货')}
        </div>

        <div className="grid grid-cols-[280px_1fr] gap-4 items-start">
          <div className="bg-white rounded border border-gray-200 shadow-sm p-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Supplier' : '供应商'}</label>
            <select
              value={supplierId}
              onChange={e => setSupplierId(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none mb-3"
            >
              <option value="">{isEn ? 'Select a supplier...' : '请选择供应商...'}</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Quotation file (PDF / Excel / CSV)' : '报价单文件（PDF / Excel / CSV）'}</label>
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.csv"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
            />
            {file && <p className="mt-1 text-xs text-gray-400">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>}
            <button
              onClick={handleImport}
              disabled={importing || !supplierId || !file}
              className="w-full mt-3 h-8 text-sm font-medium rounded text-white disabled:opacity-50"
              style={{ background: PURPLE }}
            >
              {importing ? (isEn ? 'Parsing…' : '解析中…') : (isEn ? 'Parse and generate purchase order draft' : '解析并生成采购单草稿')}
            </button>
          </div>

          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            {!result ? (
              <div className="py-20 text-center text-gray-400 text-sm">{isEn ? 'After uploading a quotation, product details and cost trends will appear here' : '上传报价单后，商品明细和进价环比会显示在这里'}</div>
            ) : (
              <>
                {result.createdPO && (
                  <div className="flex items-center gap-2 px-4 py-2.5 text-sm border-b border-gray-100" style={{ background: '#e5f1e9', color: '#2e7d4f' }}>
                    {isEn ? '✓ Purchase order draft generated' : '✓ 已生成采购单草稿'}
                    <button onClick={() => router.push(`${prefix}/classic/operator/purchases/${result.createdPO!.id}`)} className="font-semibold underline">
                      {result.createdPO.name}
                    </button>
                    {isEn
                      ? `, ${result.stats.exactMatch + result.stats.fuzzyMatch} items matched`
                      : `，共 ${result.stats.exactMatch + result.stats.fuzzyMatch} 项已匹配商品`}
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                        <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Product' : '商品'}</th>
                        <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Qty' : '数量'}</th>
                        <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'This Quote' : '本次报价'}</th>
                        <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Last 8 Trend' : '近8次走势'}</th>
                        <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Cost Change' : '进价环比'}</th>
                        <th className="px-4 py-2.5 text-center font-medium text-gray-600 text-xs">{isEn ? 'Match' : '匹配'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.lines.map((l, i) => {
                        const t = l.matchedProductId ? trends[l.matchedProductId] : null
                        return (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="px-4 py-2.5" style={{ color: l.matchedProductId ? PURPLE : '#9ca3af' }}>
                              {l.matchedProductName ?? l.rawProductName}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{l.quantity}</td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{eur(l.unitCost)}</td>
                            <td className="px-4 py-2.5">
                              <Sparkline costs={t?.recentCosts ?? []} />
                            </td>
                            <td className="px-4 py-2.5">
                              {t && t.changePct != null ? (
                                <span className="font-semibold" style={{ color: t.changePct > 0 ? '#b6412a' : t.changePct < 0 ? '#2e7d4f' : '#6b7280' }}>
                                  {t.changePct > 0 ? '↑' : t.changePct < 0 ? '↓' : ''} {Math.abs(t.changePct).toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-gray-400 text-xs">{t ? (isEn ? 'First purchase' : '首次采购') : '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                                l.confidence === 'exact' ? 'bg-green-100 text-green-700' :
                                l.confidence === 'fuzzy' ? 'bg-yellow-100 text-yellow-700' :
                                'bg-red-100 text-red-600'
                              }`}>
                                {l.confidence === 'exact' ? (isEn ? 'Exact' : '精确') : l.confidence === 'fuzzy' ? (isEn ? 'Fuzzy' : '模糊') : (isEn ? 'No Match' : '未匹配')}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
