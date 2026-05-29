'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

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
  status: string
  generatedAt: string
}

interface Supplier {
  id: string
  name: string
  vendorTaxRate?: number
}

interface ConvertForm {
  qty: number
  supplierId: string
  supplierName: string
  unitCost: number
  taxRate: number
  notes: string
}

const PRIORITY_LABEL: Record<string, string> = {
  critical: '紧急',
  high: '高',
  normal: '正常',
}
const PRIORITY_COLOR: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  normal: 'bg-green-50 text-green-700',
}

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'ordered', label: '已下单' },
  { key: 'rejected', label: '已忽略' },
]

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  approved: '已采纳',
  rejected: '已忽略',
  ordered: '已下单',
}
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-50 text-yellow-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-gray-100 text-gray-500',
  ordered: 'bg-blue-50 text-blue-700',
}

const PAGE_SIZE = 50

export default function PurchaseSuggestionsPage() {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editQty, setEditQty] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Processing state
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())

  // Suppliers for modal dropdown
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // Convert modal
  const [convertTarget, setConvertTarget] = useState<Suggestion | null>(null)
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    qty: 0, supplierId: '', supplierName: '', unitCost: 0, taxRate: 0, notes: '',
  })
  const [converting, setConverting] = useState(false)

  // Batch convert modal
  const [batchConvertItems, setBatchConvertItems] = useState<Suggestion[]>([])
  const [batchConverting, setBatchConverting] = useState(false)

  // Load suppliers once
  useEffect(() => {
    apiGet<{ items?: Supplier[] } | Supplier[]>('/api/customers?isVendor=true&limit=200')
      .then(data => {
        const list = Array.isArray(data) ? data : (data.items ?? [])
        setSuppliers(list)
      })
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      const data = await apiGet<{ items: Suggestion[]; total: number }>(`/api/purchase-suggestions?${params}`)
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      setSelectedIds(new Set())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, page])

  useEffect(() => { load() }, [load])

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  /* ---------- Generate ---------- */
  async function handleGenerate() {
    setGenerating(true)
    try {
      const result = await apiPost<{ generated: number }>('/api/purchase-suggestions', {})
      toast.success(`已生成 ${result.generated} 条采购建议`)
      setActiveTab('pending')
      setPage(1)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  /* ---------- Open convert modal (single) ---------- */
  function openConvertModal(s: Suggestion) {
    const supplier = suppliers.find(sp => sp.id === s.supplierId)
    setConvertTarget(s)
    setConvertForm({
      qty: s.suggestedQty,
      supplierId: s.supplierId ?? '',
      supplierName: s.supplierName ?? supplier?.name ?? '',
      unitCost: s.estimatedCost && s.suggestedQty > 0
        ? Number((s.estimatedCost / s.suggestedQty).toFixed(4))
        : 0,
      taxRate: supplier?.vendorTaxRate ?? 0,
      notes: '',
    })
  }

  /* ---------- Convert single suggestion to PO ---------- */
  async function handleConvert() {
    if (!convertTarget) return
    setConverting(true)
    try {
      await apiPost(`/api/purchase-suggestions/${convertTarget.id}/convert`, {
        qty: convertForm.qty,
        supplierId: convertForm.supplierId,
        supplierName: convertForm.supplierName,
        unitCost: convertForm.unitCost,
        taxRate: convertForm.taxRate,
        notes: convertForm.notes || undefined,
      })
      toast.success(`已创建采购单：${convertTarget.productName}`)
      setConvertTarget(null)
      // Update local state
      setItems(prev => prev.map(item =>
        item.id === convertTarget.id ? { ...item, status: 'ordered' } : item
      ))
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(convertTarget.id)
        return next
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '转采购单失败')
    } finally {
      setConverting(false)
    }
  }

  /* ---------- Batch convert ---------- */
  function openBatchConvert() {
    const selected = items.filter(i => selectedIds.has(i.id) && i.status === 'pending')
    if (selected.length === 0) return
    setBatchConvertItems(selected)
  }

  async function handleBatchConvert() {
    if (batchConvertItems.length === 0) return
    setBatchConverting(true)
    let success = 0
    let failed = 0

    for (const s of batchConvertItems) {
      try {
        const supplier = suppliers.find(sp => sp.id === s.supplierId)
        const unitCost = s.estimatedCost && s.suggestedQty > 0
          ? Number((s.estimatedCost / s.suggestedQty).toFixed(4))
          : 0
        await apiPost(`/api/purchase-suggestions/${s.id}/convert`, {
          qty: s.suggestedQty,
          supplierId: s.supplierId ?? '',
          supplierName: s.supplierName ?? supplier?.name ?? '',
          unitCost,
          taxRate: supplier?.vendorTaxRate ?? 0,
        })
        success++
      } catch {
        failed++
      }
    }

    if (success > 0) {
      toast.success(`已创建 ${success} 个采购单${failed > 0 ? `，${failed} 个失败` : ''}`)
    } else {
      toast.error('批量转采购单失败')
    }

    setBatchConvertItems([])
    setSelectedIds(new Set())
    setBatchConverting(false)
    load()
  }

  /* ---------- Reject (single + batch) ---------- */
  async function handleReject(id: string) {
    setProcessingIds(prev => new Set(prev).add(id))
    try {
      await apiPut(`/api/purchase-suggestions/${id}`, { status: 'rejected' })
      toast.success('已忽略')
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, status: 'rejected' } : item
      ))
      setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setProcessingIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function handleBatchReject() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setProcessingIds(new Set(ids))
    let success = 0
    let failed = 0
    for (const id of ids) {
      try {
        await apiPut(`/api/purchase-suggestions/${id}`, { status: 'rejected' })
        success++
      } catch { failed++ }
    }
    if (success > 0) {
      toast.success(`已忽略 ${success} 条${failed > 0 ? `，${failed} 条失败` : ''}`)
    } else { toast.error('批量忽略失败') }
    setSelectedIds(new Set())
    setProcessingIds(new Set())
    load()
  }

  /* ---------- Reactivate ---------- */
  async function handleReactivate(id: string) {
    setProcessingIds(prev => new Set(prev).add(id))
    try {
      await apiPut(`/api/purchase-suggestions/${id}`, { status: 'pending' })
      toast.success('已重新激活')
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, status: 'pending' } : item
      ))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setProcessingIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  /* ---------- Inline quantity edit ---------- */
  function startEditQty(item: Suggestion) {
    setEditingId(item.id)
    setEditQty(String(item.suggestedQty))
  }

  async function saveEditQty() {
    if (!editingId) return
    const qty = Number(editQty)
    if (isNaN(qty) || qty <= 0) {
      toast.error('请输入有效数量')
      return
    }
    setProcessingIds(prev => new Set(prev).add(editingId))
    try {
      await apiPut(`/api/purchase-suggestions/${editingId}`, { suggestedQty: qty })
      setItems(prev => prev.map(item =>
        item.id === editingId ? { ...item, suggestedQty: qty } : item
      ))
      toast.success('数量已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setEditingId(null)
      setProcessingIds(prev => { const n = new Set(prev); n.delete(editingId!); return n })
    }
  }

  function cancelEditQty() {
    setEditingId(null)
    setEditQty('')
  }

  /* ---------- Selection ---------- */
  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const pendingItems = items.filter(i => i.status === 'pending')
    if (selectedIds.size === pendingItems.length && pendingItems.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(pendingItems.map(i => i.id)))
    }
  }

  /* ---------- Tab ---------- */
  function handleTabChange(tab: string) {
    setActiveTab(tab)
    setPage(1)
    setSelectedIds(new Set())
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pendingItems = items.filter(i => i.status === 'pending')
  const hasPendingSelection = selectedIds.size > 0

  // Computed cost for convert modal
  const convertSubtotal = convertForm.qty * convertForm.unitCost
  const convertTax = convertSubtotal * convertForm.taxRate
  const convertTotal = convertSubtotal + convertTax

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <OdooControlPanel
        breadcrumb={['采购', '采购建议']}
        permanentActions={[
          {
            label: generating ? '生成中...' : '生成采购建议',
            onClick: handleGenerate,
            primary: true,
          },
        ]}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => setPage(p)}
        searchValue=""
        onSearch={() => {}}
      />

      {/* Status tabs */}
      <div className="bg-white border-b border-gray-200 px-4 flex gap-0">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className="px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap"
            style={{
              borderBottomColor: activeTab === tab.key ? '#875A7B' : 'transparent',
              color: activeTab === tab.key ? '#875A7B' : '#6b7280',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Batch action bar */}
      {hasPendingSelection && (
        <div className="bg-indigo-50 border-b border-indigo-200 px-4 py-2 flex items-center gap-3">
          <span className="text-sm text-indigo-700 font-medium">
            已选择 {selectedIds.size} 条
          </span>
          <button
            onClick={openBatchConvert}
            className="px-3 py-1 text-xs font-medium rounded text-white transition-colors hover:opacity-90"
            style={{ backgroundColor: '#875A7B' }}
          >
            批量采纳
          </button>
          <button
            onClick={handleBatchReject}
            className="px-3 py-1 text-xs font-medium rounded bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
          >
            批量忽略
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-gray-500 hover:text-gray-700"
          >
            取消选择
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">
            {activeTab === 'all' ? '暂无采购建议，点击「生成采购建议」自动分析缺货情况' : '暂无数据'}
          </div>
        ) : (
          <table className="w-full text-sm border-collapse bg-white">
            <thead>
              <tr className="border-b border-gray-200" style={{ background: '#f9f9f9' }}>
                <th className="px-3 py-2.5 text-center w-10">
                  {pendingItems.length > 0 && (
                    <input
                      type="checkbox"
                      checked={selectedIds.size === pendingItems.length && pendingItems.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                  )}
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">商品</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">当前库存</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">需求量</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">建议采购</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">推荐供应商</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">预估成本</th>
                <th className="px-4 py-2.5 text-center font-medium text-gray-500 text-xs">优先级</th>
                <th className="px-4 py-2.5 text-center font-medium text-gray-500 text-xs">状态</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">生成时间</th>
                <th className="px-4 py-2.5 text-center font-medium text-gray-500 text-xs w-36">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => {
                const shortageRate = s.demandQty > 0 ? ((s.demandQty - s.currentStock) / s.demandQty * 100) : 0
                const isProcessing = processingIds.has(s.id)
                const isEditing = editingId === s.id
                return (
                  <tr key={s.id} className="border-b border-gray-100 hover:bg-blue-50/50 transition-colors group">
                    {/* Checkbox */}
                    <td className="px-3 py-2.5 text-center">
                      {s.status === 'pending' && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(s.id)}
                          onChange={() => toggleSelect(s.id)}
                          className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                      )}
                    </td>

                    {/* Product name */}
                    <td className="px-4 py-2.5 font-medium text-gray-900">{s.productName}</td>

                    {/* Current stock */}
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      <span className={s.currentStock <= 0 ? 'text-red-600 font-semibold' : ''}>
                        {s.currentStock}
                      </span>
                    </td>

                    {/* Demand qty */}
                    <td className="px-4 py-2.5 text-right text-gray-700">{s.demandQty}</td>

                    {/* Suggested qty (editable for pending) */}
                    <td className="px-4 py-2.5 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <input
                            ref={editInputRef}
                            type="number"
                            min={1}
                            value={editQty}
                            onChange={e => setEditQty(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEditQty()
                              if (e.key === 'Escape') cancelEditQty()
                            }}
                            className="w-20 px-2 py-0.5 text-right text-sm border border-purple-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-400"
                          />
                          <button onClick={saveEditQty} className="text-green-600 hover:text-green-700 text-xs font-medium">
                            &#10003;
                          </button>
                          <button onClick={cancelEditQty} className="text-gray-400 hover:text-gray-600 text-xs">
                            &#10005;
                          </button>
                        </div>
                      ) : (
                        <span
                          className={`font-semibold ${s.status === 'pending' ? 'cursor-pointer hover:underline' : ''}`}
                          style={{ color: '#875A7B' }}
                          onClick={() => s.status === 'pending' && startEditQty(s)}
                          title={s.status === 'pending' ? '点击修改数量' : undefined}
                        >
                          {s.suggestedQty}
                        </span>
                      )}
                    </td>

                    {/* Supplier */}
                    <td className="px-4 py-2.5 text-gray-600">{s.supplierName ?? '-'}</td>

                    {/* Estimated cost */}
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      {s.estimatedCost != null ? `€${s.estimatedCost.toFixed(2)}` : '-'}
                    </td>

                    {/* Priority */}
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_COLOR[s.priority] ?? 'bg-gray-100 text-gray-600'}`}>
                        {PRIORITY_LABEL[s.priority] ?? s.priority}
                      </span>
                      {shortageRate > 0 && (
                        <span className="ml-1 text-[10px] text-gray-400">
                          {shortageRate.toFixed(0)}%
                        </span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLOR[s.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[s.status] ?? s.status}
                      </span>
                    </td>

                    {/* Generated at */}
                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                      {s.generatedAt ? new Date(s.generatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-2.5 text-center">
                      {isProcessing ? (
                        <span className="text-xs text-gray-400">处理中...</span>
                      ) : s.status === 'pending' ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openConvertModal(s)}
                            className="px-2.5 py-1 text-xs font-medium rounded text-white transition-colors hover:opacity-90"
                            style={{ backgroundColor: '#875A7B' }}
                          >
                            采纳
                          </button>
                          <button
                            onClick={() => handleReject(s.id)}
                            className="px-2.5 py-1 text-xs font-medium rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                          >
                            忽略
                          </button>
                        </div>
                      ) : s.status === 'approved' ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openConvertModal(s)}
                            className="px-2.5 py-1 text-xs font-medium rounded text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                          >
                            转采购单
                          </button>
                          <button
                            onClick={() => handleReject(s.id)}
                            className="px-2.5 py-1 text-xs font-medium rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                          >
                            忽略
                          </button>
                        </div>
                      ) : s.status === 'rejected' ? (
                        <button
                          onClick={() => handleReactivate(s.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                        >
                          重新激活
                        </button>
                      ) : s.status === 'ordered' ? (
                        <span className="text-xs text-gray-400">已完成</span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {/* ==================== Convert Modal (Single) ==================== */}
      {convertTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !converting && setConvertTarget(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200" style={{ backgroundColor: '#875A7B' }}>
              <h3 className="text-lg font-semibold text-white">采纳 &mdash; 确认采购</h3>
              <button onClick={() => !converting && setConvertTarget(null)} className="text-white/80 hover:text-white text-xl leading-none">&times;</button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              {/* Product info (read-only) */}
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">商品</div>
                <div className="font-semibold text-gray-900">{convertTarget.productName}</div>
                <div className="flex gap-6 mt-2 text-xs text-gray-500">
                  <span>当前库存: <b className="text-gray-700">{convertTarget.currentStock}</b></span>
                  <span>需求量: <b className="text-gray-700">{convertTarget.demandQty}</b></span>
                  <span>缺口: <b className="text-red-600">{Math.max(0, convertTarget.demandQty - convertTarget.currentStock)}</b></span>
                </div>
              </div>

              {/* Quantity */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">采购数量</label>
                <input
                  type="number"
                  min={1}
                  value={convertForm.qty}
                  onChange={e => setConvertForm(f => ({ ...f, qty: Number(e.target.value) }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
                />
              </div>

              {/* Supplier */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">供应商</label>
                <select
                  value={convertForm.supplierId}
                  onChange={e => {
                    const sp = suppliers.find(s => s.id === e.target.value)
                    setConvertForm(f => ({
                      ...f,
                      supplierId: e.target.value,
                      supplierName: sp?.name ?? '',
                      taxRate: sp?.vendorTaxRate ?? f.taxRate,
                    }))
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
                >
                  <option value="">-- 请选择供应商 --</option>
                  {suppliers.map(sp => (
                    <option key={sp.id} value={sp.id}>{sp.name}</option>
                  ))}
                </select>
              </div>

              {/* Unit cost */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">单价 (€)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={convertForm.unitCost}
                    onChange={e => setConvertForm(f => ({ ...f, unitCost: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">税率</label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={convertForm.taxRate}
                    onChange={e => setConvertForm(f => ({ ...f, taxRate: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
                  />
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <textarea
                  rows={2}
                  value={convertForm.notes}
                  onChange={e => setConvertForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="选填"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400 resize-none"
                />
              </div>

              {/* Cost summary */}
              <div className="bg-gray-50 rounded-lg p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">小计 (不含税)</span>
                  <span className="font-medium">€{convertSubtotal.toFixed(2)}</span>
                </div>
                {convertForm.taxRate > 0 && (
                  <div className="flex justify-between mt-1">
                    <span className="text-gray-500">税额 ({(convertForm.taxRate * 100).toFixed(0)}%)</span>
                    <span className="font-medium">€{convertTax.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between mt-1 pt-1 border-t border-gray-200">
                  <span className="font-semibold text-gray-700">合计</span>
                  <span className="font-bold text-lg" style={{ color: '#875A7B' }}>€{convertTotal.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={() => setConvertTarget(null)}
                disabled={converting}
                className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleConvert}
                disabled={converting || !convertForm.supplierId || convertForm.qty <= 0}
                className="px-5 py-2 text-sm font-medium rounded-md text-white transition-colors hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#875A7B' }}
              >
                {converting ? '创建中...' : '确认采购'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Batch Convert Modal ==================== */}
      {batchConvertItems.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !batchConverting && setBatchConvertItems([])}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200" style={{ backgroundColor: '#875A7B' }}>
              <h3 className="text-lg font-semibold text-white">批量采纳 &mdash; 确认创建采购单</h3>
              <button onClick={() => !batchConverting && setBatchConvertItems([])} className="text-white/80 hover:text-white text-xl leading-none">&times;</button>
            </div>

            {/* Body */}
            <div className="px-6 py-5">
              <p className="text-sm text-gray-600 mb-4">
                将以下 <b>{batchConvertItems.length}</b> 条建议转为采购单，每条建议生成一个独立采购单：
              </p>
              <div className="max-h-64 overflow-auto border border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-3 py-2 text-left font-medium text-gray-500">商品</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">数量</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500">供应商</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">预估成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchConvertItems.map(s => (
                      <tr key={s.id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-medium text-gray-900">{s.productName}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{s.suggestedQty}</td>
                        <td className="px-3 py-2 text-gray-600">{s.supplierName ?? '-'}</td>
                        <td className="px-3 py-2 text-right text-gray-700">
                          {s.estimatedCost != null ? `€${s.estimatedCost.toFixed(2)}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-xs text-gray-500">
                采购数量和供应商将使用建议的默认值。如需修改，请逐条点击「采纳」。
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                onClick={() => setBatchConvertItems([])}
                disabled={batchConverting}
                className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleBatchConvert}
                disabled={batchConverting}
                className="px-5 py-2 text-sm font-medium rounded-md text-white transition-colors hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#875A7B' }}
              >
                {batchConverting ? '创建中...' : `确认创建 ${batchConvertItems.length} 个采购单`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
