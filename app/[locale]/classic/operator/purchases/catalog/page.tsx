'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiUpload } from '@/lib/api'
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

interface MatchCandidate { id: string; name: string; score: number }

interface ParsedLine {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
  matchedProductId: string | null
  matchedProductName: string | null
  confidence: 'exact' | 'strong' | 'weak' | 'none'
  candidates: MatchCandidate[]
  ambiguous: boolean
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
    stats: { total: number; exact: number; strong: number; weak: number; none: number; ambiguous: number } | null
    lines: ParsedLine[]
    currency: string | null
    supplierId: string | null
    supplierName: string | null
    sourceDocumentUrl: string | null
    sourceDocumentName: string
    error?: string | null
  } | null>(null)
  const [creating, setCreating] = useState(false)
  const [createdPO, setCreatedPO] = useState<{ id: string; name: string } | null>(null)
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
    setCreatedPO(null)
    setFile(null)
    setSupplierId('')
    setTrends({})
  }

  /**
   * 只解析，**不建单**。
   *
   * ⛔ 这里以前调的是 `/api/purchase-orders/import`，那个接口识别完直接创建 DRAFT 采购单，
   * 且匹配用的是双向子串包含 —— 实测把 `Harvest Beans` 配成库里的垃圾商品 `vest`
   * 并落了库，未匹配的行还被静默丢弃。现在统一走 `/api/purchase-orders/parse`：
   * 只返回结果与候选，人核对完点「创建采购单草稿」才落库。
   */
  async function handleParse() {
    if (!file) { toast.error(isEn ? 'Please select a file' : '请选择文件'); return }
    setImporting(true)
    setCreatedPO(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const data = await apiUpload<{
        stats: { total: number; exact: number; strong: number; weak: number; none: number; ambiguous: number } | null
        lines: ParsedLine[]
        currency: string | null
        supplierId: string | null
        supplierName: string | null
        sourceDocumentUrl: string | null
        sourceDocumentName: string
        error?: string | null
      }>('/api/purchase-orders/parse', fd)
      setResult(data)
      if (data.error) toast.warning(data.error)
      // 识别到系统里已有的供应商就自动选上，省一次手选；认不出就保持人工选择
      if (data.supplierId) setSupplierId(data.supplierId)
      else if (data.supplierName) {
        toast.info(isEn
          ? `Detected supplier "${data.supplierName}", not in system — please select manually`
          : `识别到供应商「${data.supplierName}」，系统中无此供应商，请手动选择`)
      }

      const ids = data.lines.map(l => l.matchedProductId).filter(Boolean) as string[]
      if (ids.length > 0) {
        apiGet<Record<string, PriceTrend>>(`/api/analytics/price-trends?productIds=${ids.join(',')}`)
          .then(setTrends)
          .catch(() => {})
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Parse failed' : '解析失败'))
    } finally {
      setImporting(false)
    }
  }

  /** 人工改选某行匹配到的商品 */
  function pickProduct(idx: number, productId: string) {
    setResult(prev => {
      if (!prev) return prev
      const lines = [...prev.lines]
      const line = lines[idx]
      const hit = line.candidates.find(c => c.id === productId)
      lines[idx] = {
        ...line,
        matchedProductId: hit?.id ?? null,
        matchedProductName: hit?.name ?? null,
        confidence: hit ? 'exact' : 'none',
        ambiguous: false,
      }
      return { ...prev, lines }
    })
  }

  /** 核对完毕才落库。未匹配的行不会被静默丢弃 —— 提交前明确告知会漏掉几行 */
  async function handleCreatePO() {
    if (!supplierId) { toast.error(isEn ? 'Please select a supplier' : '请选择供应商'); return }
    const matched = (result?.lines ?? []).filter(l => l.matchedProductId && (l.quantity ?? 0) > 0)
    if (matched.length === 0) {
      toast.error(isEn ? 'No matched line to create' : '没有可创建的已匹配行')
      return
    }
    const skipped = (result?.lines ?? []).length - matched.length
    if (skipped > 0) {
      const ok = window.confirm(isEn
        ? `${skipped} line(s) are not matched to a product and will NOT be included. Continue?`
        : `有 ${skipped} 行未匹配到商品，将不会写入采购单。继续？`)
      if (!ok) return
    }
    setCreating(true)
    try {
      const po = await apiPost<{ id: string; name: string }>('/api/purchase-orders', {
        supplierId,
        currency: result?.currency ?? 'EUR',
        sourceDocumentUrl: result?.sourceDocumentUrl ?? null,
        sourceDocumentName: result?.sourceDocumentName ?? null,
        notes: `从单据识别导入：${result?.sourceDocumentName ?? ''}`,
        lines: matched.map(l => ({
          productId: l.matchedProductId!,
          productName: l.matchedProductName ?? l.productName,
          orderedQty: l.quantity ?? 0,
          unitCost: l.unitCost ?? 0,
          taxRate: 0,
        })),
      })
      setCreatedPO(po)
      toast.success(isEn ? `Purchase order draft ${po.name} created` : `已创建采购单草稿 ${po.name}`)
      loadLastByGroup()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Create failed' : '创建失败'))
    } finally {
      setCreating(false)
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
            <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Quotation file (PDF / Photo / Excel / CSV)' : '报价单文件（PDF / 拍照 / Excel / CSV）'}</label>
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
            />
            {file && <p className="mt-1 text-xs text-gray-400">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>}
            <button
              onClick={handleParse}
              disabled={importing || !file}
              className="w-full mt-3 h-8 text-sm font-medium rounded text-white disabled:opacity-50"
              style={{ background: PURPLE }}
            >
              {importing ? (isEn ? 'Parsing…' : '解析中…') : (isEn ? 'Parse document' : '解析单据')}
            </button>
            <p className="mt-2 text-xs text-gray-400">
              {isEn
                ? 'Parsing does not save anything. Review the lines on the right, then create the draft.'
                : '解析不会保存任何数据。请核对右侧明细后再创建草稿。'}
            </p>
          </div>

          <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
            {!result ? (
              <div className="py-20 text-center text-gray-400 text-sm">{isEn ? 'After uploading a quotation, product details and cost trends will appear here' : '上传报价单后，商品明细和进价环比会显示在这里'}</div>
            ) : (
              <>
                {createdPO ? (
                  <div className="flex items-center gap-2 px-4 py-2.5 text-sm border-b border-gray-100" style={{ background: '#e5f1e9', color: '#2e7d4f' }}>
                    {isEn ? '✓ Purchase order draft created' : '✓ 已创建采购单草稿'}
                    <button onClick={() => router.push(`${prefix}/classic/operator/purchases/${createdPO.id}`)} className="font-semibold underline">
                      {createdPO.name}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm border-b border-gray-100 bg-gray-50">
                    <span className="text-xs text-gray-600">
                      {result.stats && (isEn
                        ? `${result.stats.total} lines · ${result.stats.exact + result.stats.strong} matched · ${result.stats.weak} to verify · ${result.stats.none} unmatched`
                        : `共 ${result.stats.total} 行 · 已匹配 ${result.stats.exact + result.stats.strong} · 存疑 ${result.stats.weak} · 未匹配 ${result.stats.none}`)}
                    </span>
                    <button
                      onClick={handleCreatePO}
                      disabled={creating || !supplierId}
                      className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                      style={{ background: PURPLE }}
                    >
                      {creating
                        ? (isEn ? 'Creating…' : '创建中…')
                        : (isEn ? 'Create purchase order draft' : '创建采购单草稿')}
                    </button>
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
                            <td className="px-4 py-2.5">
                              <div className="text-xs text-gray-500 mb-0.5">{l.productName}</div>
                              {l.candidates.length > 0 ? (
                                <select
                                  value={l.matchedProductId ?? ''}
                                  onChange={e => pickProduct(i, e.target.value)}
                                  className={`w-full border rounded px-1 py-0.5 text-xs ${l.matchedProductId ? 'border-gray-300' : 'border-red-300 bg-red-50'}`}
                                >
                                  <option value="">
                                    {l.ambiguous
                                      ? (isEn ? '— multiple matches, pick one —' : '— 命中多个，请选择 —')
                                      : (isEn ? '— not matched —' : '— 未匹配 —')}
                                  </option>
                                  {l.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                              ) : (
                                <span className="text-xs text-red-500">{isEn ? 'no candidate' : '无候选商品'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{l.quantity}</td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{l.unitCost == null ? '—' : eur(l.unitCost)}</td>
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
                                l.confidence === 'strong' ? 'bg-green-50 text-green-600' :
                                l.confidence === 'weak' ? 'bg-yellow-100 text-yellow-700' :
                                'bg-red-100 text-red-600'
                              }`}>
                                {l.confidence === 'exact' ? (isEn ? 'Exact' : '精确')
                                  : l.confidence === 'strong' ? (isEn ? 'Strong' : '较可靠')
                                    : l.confidence === 'weak' ? (isEn ? 'Verify' : '存疑')
                                      : (isEn ? 'No Match' : '未匹配')}
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
