'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

interface PlanRow {
  id: string
  productId: string
  productName: string
  demandQty: number // 近12个月采购量
  suggestedQty: number
  supplierId: string | null
  supplierName: string | null
  estimatedCost: number | null
  reason: string | null
}

interface ReceiptEvent {
  id: string
  poName: string
  arrivedAt: string
  lineCount: number
  totalQty: number
}

export default function AnnualPlanPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [rows, setRows] = useState<PlanRow[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [receipts, setReceipts] = useState<ReceiptEvent[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ items: PlanRow[] }>('/api/purchase-suggestions?status=pending&categoryGroupKey=DRY_GOODS&pageSize=200')
      const items = data.items ?? (data as unknown as PlanRow[])
      setRows(items)
      setSelected(new Set(items.map(r => r.id)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    apiGet<ReceiptEvent[]>('/api/purchase-orders/receipts-by-group?groupKey=DRY_GOODS&months=12')
      .then(setReceipts)
      .catch(() => {})
  }, [])

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await apiPost<{ generated: number }>('/api/purchase-suggestions/generate-annual', {})
      toast.success(`已生成 ${res.generated} 条年度计划建议`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.id)))
  }

  async function handleSubmit() {
    if (selected.size === 0) { toast.error('请先勾选要纳入计划的商品'); return }
    setSubmitting(true)
    try {
      const res = await apiPost<{ createdPOs: Array<{ id: string; name: string }>; skippedCount: number }>(
        '/api/purchase-suggestions/convert',
        { suggestionIds: Array.from(selected), advanceToApproval: true },
      )
      if (res.skippedCount > 0) toast.warning(`${res.skippedCount} 项因无配置供应商被跳过`)
      if (res.createdPOs.length > 0) {
        toast.success(`已提交审批：${res.createdPOs.map(p => p.name).join(', ')}`)
        router.push(`${prefix}/classic/operator/purchases`)
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交审批失败')
    } finally {
      setSubmitting(false)
    }
  }

  const selectedRows = rows.filter(r => selected.has(r.id))
  const totalRecentQty = selectedRows.reduce((s, r) => s + Number(r.demandQty), 0)
  const totalSuggestedQty = selectedRows.reduce((s, r) => s + Number(r.suggestedQty), 0)
  const totalCost = selectedRows.reduce((s, r) => s + (r.estimatedCost ?? 0), 0)
  const growthPct = totalRecentQty > 0 ? ((totalSuggestedQty - totalRecentQty) / totalRecentQty) * 100 : null

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="text-xs text-gray-500 mb-1">
          <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)} className="hover:underline" style={{ color: PURPLE }}>采购</button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">干货 · 年度采购计划</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-900">🌾 干货 · 年度采购计划</h1>
          <button onClick={handleGenerate} disabled={generating}
            className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {generating ? '生成中…' : rows.length > 0 ? '重新生成' : '生成计划'}
          </button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="bg-white rounded border border-gray-200 shadow-sm">
          <div className="grid grid-cols-3 divide-x divide-gray-200">
            <div className="p-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">近12个月采购量（已选商品）</div>
              <div className="text-xl font-bold text-gray-900">{totalRecentQty.toFixed(1)}</div>
            </div>
            <div className="p-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">建议年度采购量</div>
              <div className="text-xl font-bold text-gray-900">{totalSuggestedQty.toFixed(1)}</div>
              {growthPct != null && (
                <div className="text-xs mt-1" style={{ color: growthPct >= 0 ? '#b6412a' : '#2e7d4f' }}>
                  {growthPct >= 0 ? '+' : ''}{growthPct.toFixed(1)}%
                </div>
              )}
            </div>
            <div className="p-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">预计年度采购总额</div>
              <div className="text-xl font-bold text-gray-900">{eur(totalCost)}</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">近12个月到货记录</h3>
          {receipts.length === 0 ? (
            <div className="text-sm text-gray-400">近12个月暂无干货类到货记录</div>
          ) : (
            <div className="flex flex-col gap-2">
              {receipts.map(r => (
                <div key={r.id} className="flex items-center gap-3 text-sm">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#2e7d4f' }} />
                  <span className="text-gray-400 font-mono text-xs w-24 flex-shrink-0">{formatDateOnly(r.arrivedAt)}</span>
                  <span className="text-gray-700">{r.poName}</span>
                  <span className="text-gray-400 text-xs">· {r.lineCount} 项，共 {r.totalQty.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-24 text-gray-400">
              <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
              加载中...
            </div>
          ) : rows.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm">点击右上「生成计划」开始（需要该品类近12个月有采购历史）</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                    <th className="w-10 px-3 py-2.5 text-center">
                      <input type="checkbox" checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} className="w-3.5 h-3.5 accent-purple-700 cursor-pointer" />
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">商品</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">近12个月采购量</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">建议年度采购量</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">供应商</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">预估单价</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">预估金额</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-b border-gray-100 hover:bg-blue-50/30 transition-colors" title={r.reason ?? ''}>
                      <td className="px-3 py-2.5 text-center">
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} className="w-3.5 h-3.5 accent-purple-700 cursor-pointer" />
                      </td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>{r.productName}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{Number(r.demandQty).toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-gray-900">{Number(r.suggestedQty).toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-gray-600 text-xs">{r.supplierName ?? '—（未配置供应商）'}</td>
                      <td className="px-4 py-2.5 text-right text-gray-500 text-xs">
                        {r.estimatedCost != null && Number(r.suggestedQty) > 0 ? eur(r.estimatedCost / Number(r.suggestedQty)) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{r.estimatedCost != null ? eur(r.estimatedCost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                <div className="text-sm text-gray-600">
                  已选 <b className="text-gray-900">{selected.size}</b> 项 · 预估合计 <b className="text-gray-900">{eur(totalCost)}</b>
                </div>
                <button onClick={handleSubmit} disabled={submitting || selected.size === 0}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {submitting ? '提交中…' : '提交审批'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
