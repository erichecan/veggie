'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { eur } from '@/lib/format-money'

const PURPLE = '#875A7B'

interface Suggestion {
  id: string
  productId: string
  productName: string
  currentStock: number
  demandQty: number
  suggestedQty: number
  supplierId: string | null
  supplierName: string | null
  estimatedCost: number | null
  priority: string
  reason: string | null
  generatedAt: string
}

export default function FreshDailySuggestionsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [rows, setRows] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [converting, setConverting] = useState(false)
  const [generatedToday, setGeneratedToday] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ items: Suggestion[] }>('/api/purchase-suggestions?status=pending&categoryGroupKey=FRESH_FROZEN&pageSize=100')
      const items = data.items ?? (data as unknown as Suggestion[])
      setRows(items)
      // 已有的自动全选(采购员可再手动取消不想采的行)
      setSelected(new Set(items.map(r => r.id)))
      const todayStr = new Date().toDateString()
      setGeneratedToday(items.some(r => new Date(r.generatedAt).toDateString() === todayStr))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await apiPost<{ generated: number }>('/api/purchase-suggestions/generate-fresh', {})
      toast.success(`已生成 ${res.generated} 条备货建议`)
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

  async function handleConvert() {
    if (selected.size === 0) { toast.error('请先勾选要采购的商品'); return }
    setConverting(true)
    try {
      const res = await apiPost<{ createdPOs: Array<{ id: string; name: string }>; skippedCount: number }>(
        '/api/purchase-suggestions/convert',
        { suggestionIds: Array.from(selected) },
      )
      if (res.skippedCount > 0) {
        toast.warning(`${res.skippedCount} 项因无配置供应商被跳过，未生成采购单`)
      }
      if (res.createdPOs.length === 1) {
        toast.success(`已生成采购单 ${res.createdPOs[0].name}`)
        router.push(`${prefix}/classic/operator/purchases/${res.createdPOs[0].id}`)
      } else if (res.createdPOs.length > 1) {
        toast.success(`已按供应商拆分生成 ${res.createdPOs.length} 张采购单：${res.createdPOs.map(p => p.name).join(', ')}`)
        router.push(`${prefix}/classic/operator/purchases`)
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成采购单失败')
    } finally {
      setConverting(false)
    }
  }

  const selectedRows = rows.filter(r => selected.has(r.id))
  const selectedCost = selectedRows.reduce((s, r) => s + (r.estimatedCost ?? 0), 0)

  return (
    <div className="flex flex-col h-full overflow-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="text-xs text-gray-500 mb-1">
          <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)} className="hover:underline" style={{ color: PURPLE }}>采购</button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">生鲜冷冻 · 次日备货清单</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-900">🥬 蔬菜生鲜冷冻 · 次日备货清单</h1>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {generating ? '生成中…' : generatedToday ? '重新生成' : '生成今日建议'}
          </button>
        </div>
      </div>

      <div className="p-6">
        <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded text-sm" style={{ background: '#e5f1e9', color: '#2e7d4f' }}>
          ✓ 依据近 3 日日均出货 + 已确认未来订单，不看安全库存（生鲜不囤货）。
          {generatedToday ? '已生成今日建议。' : '尚未生成今日建议，点击右上「生成今日建议」。'}
        </div>

        <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-24 text-gray-400">
              <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
              加载中...
            </div>
          ) : rows.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm">
              {generatedToday ? '今日没有需要补货的生鲜商品，库存和已确认订单已覆盖。' : '点击右上「生成今日建议」开始'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                    <th className="w-10 px-3 py-2.5 text-center">
                      <input type="checkbox" checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} className="w-3.5 h-3.5 accent-purple-700 cursor-pointer" />
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">商品</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">预计需求<span className="font-normal text-gray-400">(日均+已确认订单)</span></th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">现有库存</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">建议采购量</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">建议供应商</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">预估成本</th>
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
                      <td className="px-4 py-2.5 text-right text-gray-700">{Number(r.currentStock).toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold" style={{ color: r.priority === 'critical' ? '#b6412a' : '#1f2d3d' }}>
                        {Number(r.suggestedQty).toFixed(1)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 text-xs">{r.supplierName ?? '—（未配置供应商）'}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">{r.estimatedCost != null ? eur(r.estimatedCost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                <div className="text-sm text-gray-600">
                  已选 <b className="text-gray-900">{selected.size}</b> 项 · 预估合计 <b className="text-gray-900">{eur(selectedCost)}</b>
                </div>
                <button
                  onClick={handleConvert}
                  disabled={converting || selected.size === 0}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}
                >
                  {converting ? '生成中…' : '生成采购单'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
