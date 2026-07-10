'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
  orderDate: string
  expectedDate?: string | null
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  createdAt: string
  lines: Array<{ id: string; productName: string; orderedQty: number; unitCost: number }>
}

interface Supplier {
  id: string
  name: string
}

const STATUS_LABEL: Record<POStatus, string> = {
  DRAFT:      '询价单',
  SENT:       '询价单已发送',
  TO_APPROVE: '待审批',
  CONFIRMED:  '采购订单',
  RECEIVED:   '已收货',
  INVOICED:   '已开票',
  LOCKED:     '已锁定',
  CANCELLED:  '已取消',
}

const STATUS_COLOR: Record<POStatus, string> = {
  DRAFT:      'bg-gray-100 text-gray-600',
  SENT:       'bg-blue-50 text-blue-700',
  TO_APPROVE: 'bg-yellow-50 text-yellow-700',
  CONFIRMED:  'bg-purple-50 text-purple-700',
  RECEIVED:   'bg-cyan-50 text-cyan-700',
  INVOICED:   'bg-green-50 text-green-700',
  LOCKED:     'bg-emerald-50 text-emerald-800',
  CANCELLED:  'bg-red-50 text-red-600',
}

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'DRAFT', label: '询价单' },
  { key: 'SENT', label: '询价单已发送' },
  { key: 'TO_APPROVE', label: '待审批' },
  { key: 'CONFIRMED', label: '采购订单' },
  { key: 'RECEIVED', label: '已收货' },
  { key: 'INVOICED', label: '已开票' },
  { key: 'LOCKED', label: '已锁定' },
  { key: 'CANCELLED', label: '已取消' },
]

const PAGE_SIZE = 40

export default function PurchasesPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newSupplierId, setNewSupplierId] = useState('')
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState('')
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importSupplierId, setImportSupplierId] = useState('')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    ok: boolean
    fileName: string
    stats: { total: number; exactMatch: number; fuzzyMatch: number; noMatch: number }
    lines: Array<{
      rawProductName: string; quantity: number; unitCost: number
      matchedProductId: string | null; matchedProductName: string | null
      confidence: 'exact' | 'fuzzy' | 'none'
    }>
    createdPO: { id: string; name: string } | null
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      if (search) params.set('search', search)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String((page - 1) * PAGE_SIZE))
      const data = await apiGet<{ items: PurchaseOrder[]; total: number }>(`/api/purchase-orders?${params}`)
      setPos(data.items ?? (data as unknown as PurchaseOrder[]))
      setTotal(data.total ?? (data as unknown as PurchaseOrder[]).length)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, search, page])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    apiGet<{ items: Supplier[] }>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(d.items ?? (d as unknown as Supplier[])))
      .catch(() => {})
  }, [])

  function handleTabChange(tab: string) {
    setActiveTab(tab)
    setPage(1)
    setSelected(new Set())
  }

  function toggleAll() {
    if (selected.size === pos.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(pos.map(p => p.id)))
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function handleCreate() {
    if (!newSupplierId) { toast.error('请选择供应商'); return }
    setCreating(true)
    try {
      const result = await apiPost<{ id: string }>('/api/purchase-orders', {
        supplierId: newSupplierId,
        lines: [],
      })
      router.push(`purchases/${result.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  function downloadCsvTemplate() {
    const content = '商品名称,数量,单价\n示例商品A,10,5.50\n示例商品B,20,3.20\n'
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '采购导入模板.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleImport() {
    if (!importSupplierId) { toast.error('请选择供应商'); return }
    if (!importFile) { toast.error('请选择文件'); return }
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', importFile)
      fd.append('supplierId', importSupplierId)
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
      setImportResult(data)
      if (data.createdPO) {
        toast.success(`已创建采购单草稿 ${data.createdPO.name}`)
        load()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <OdooControlPanel
        breadcrumb={['采购', '询价单']}
        permanentActions={[
          { label: '📊 总览', onClick: () => router.push(`${prefix}/classic/operator/purchases/overview`) },
          { label: '新建', onClick: () => setShowNewDialog(true), primary: true },
          { label: 'Import', onClick: () => { setShowImportDialog(true); setImportResult(null); setImportFile(null); setImportSupplierId('') } },
          { label: '🥬 生鲜次日备货', onClick: () => router.push(`${prefix}/classic/operator/purchases/fresh`) },
          { label: '🛒 目录挑选', onClick: () => router.push(`${prefix}/classic/operator/purchases/catalog`) },
          { label: '🌾 干货年度计划', onClick: () => router.push(`${prefix}/classic/operator/purchases/annual-plan`) },
        ]}
        searchValue={searchInput}
        onSearch={v => setSearchInput(v)}
        onSearchSubmit={() => { setSearch(searchInput); setPage(1) }}
        activeFilters={[
          ...(activeTab !== 'all' ? [{ label: `状态：${STATUS_LABEL[activeTab as POStatus] ?? activeTab}`, onRemove: () => handleTabChange('all') }] : []),
        ]}
        filterOptions={STATUS_TABS.filter(t => t.key !== 'all').map(t => ({ label: t.label, value: t.key }))}
        onFilterSelect={v => handleTabChange(v)}
        groupByOptions={[
          { label: '供应商', value: 'supplier' },
          { label: '状态', value: 'status' },
          { label: '订购日期', value: 'orderDate' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, activeTab, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setSearch(String(s.searchInput ?? ''))
          handleTabChange(String(s.activeTab ?? 'all'))
          setGroupBy(String(s.groupBy ?? ''))
        }}
        storageKey="classic_purchases_favs"
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => setPage(p)}
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

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            加载中...
          </div>
        ) : pos.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">暂无采购单</div>
        ) : (
          <table className="w-full text-sm border-collapse bg-white">
            <thead>
              <tr className="border-b border-gray-200" style={{ background: '#f9f9f9' }}>
                <th className="w-10 px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={selected.size === pos.length && pos.length > 0}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 accent-purple-700 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">编号</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">供应商</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">订购日期</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">预计到货</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">来源单据</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">状态</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">税前金额</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">含税总额</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const GB_FIELD: Record<string, keyof PurchaseOrder> = {
                  supplier: 'supplierName',
                  status: 'status',
                  orderDate: 'orderDate',
                }
                const field = GB_FIELD[groupBy]
                const renderRow = (po: PurchaseOrder) => (
                  <tr
                    key={po.id}
                    onClick={() => router.push(`purchases/${po.id}`)}
                    className="cursor-pointer border-b border-gray-100 hover:bg-blue-50 transition-colors"
                    style={{ background: selected.has(po.id) ? '#f0f0ff' : undefined }}
                  >
                    <td className="w-10 px-3 py-2.5 text-center" onClick={e => { e.stopPropagation(); toggleOne(po.id) }}>
                      <input
                        type="checkbox"
                        checked={selected.has(po.id)}
                        onChange={() => toggleOne(po.id)}
                        className="w-3.5 h-3.5 accent-purple-700 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: '#875A7B' }}>{po.name}</td>
                    <td className="px-4 py-2.5 text-gray-700">{po.supplierName ?? po.supplierId}</td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {po.orderDate ? new Date(po.orderDate).toLocaleDateString('en-GB') : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-GB') : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">-</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLOR[po.status]}`}>
                        {STATUS_LABEL[po.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{Number(po.subtotalExTax).toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-900">{Number(po.totalIncTax).toFixed(2)}</td>
                  </tr>
                )
                if (!groupBy || !field) return pos.map(renderRow)
                const groups = new Map<string, PurchaseOrder[]>()
                for (const po of pos) {
                  const key = String(po[field] ?? '')
                  if (!groups.has(key)) groups.set(key, [])
                  groups.get(key)!.push(po)
                }
                return Array.from(groups.entries()).flatMap(([key, groupPos]) => [
                  <tr key={`__group__${key}`} style={{ background: '#f5f0f7', borderBottom: '2px solid #d4b8d0' }}>
                    <td colSpan={9} className="px-3 py-1.5 font-semibold text-sm" style={{ color: '#6d4a66' }}>
                      {groupBy === 'status' ? STATUS_LABEL[key as POStatus] ?? key
                        : groupBy === 'orderDate' ? (key ? new Date(key).toLocaleDateString('en-GB') : '（空）')
                        : key || '（空）'}
                      {' '}<span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({groupPos.length})</span>
                    </td>
                  </tr>,
                  ...groupPos.map(renderRow),
                ])
              })()}
            </tbody>
          </table>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {/* New PO Dialog */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">新建询价单</h2>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">供应商</label>
              <select
                value={newSupplierId}
                onChange={e => setNewSupplierId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              >
                <option value="">请选择供应商...</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setShowNewDialog(false); setNewSupplierId('') }}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newSupplierId}
                className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Dialog */}
      {showImportDialog && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">导入采购单</h2>
              <button onClick={() => setShowImportDialog(false)} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
            </div>

            {!importResult ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">供应商</label>
                  <select
                    value={importSupplierId}
                    onChange={e => setImportSupplierId(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                  >
                    <option value="">请选择供应商...</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-500">文件（PDF / Excel / CSV，最大 10MB）</label>
                    <button
                      type="button"
                      onClick={downloadCsvTemplate}
                      className="text-xs font-medium hover:underline"
                      style={{ color: '#875A7B' }}
                    >
                      ↓ 下载 CSV 模板
                    </button>
                  </div>
                  <input
                    type="file"
                    accept=".pdf,.xlsx,.xls,.csv"
                    onChange={e => setImportFile(e.target.files?.[0] ?? null)}
                    className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
                  />
                  {importFile && (
                    <p className="mt-1 text-xs text-gray-400">{importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)</p>
                  )}
                  <p className="mt-1 text-xs text-gray-400">表头列：商品名称、数量、单价（顺序不限，无表头时按前三列识别）</p>
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setShowImportDialog(false)}
                    className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={importing || !importSupplierId || !importFile}
                    className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: '#875A7B' }}
                  >
                    {importing ? '导入中...' : '上传并解析'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-lg font-semibold text-gray-800">{importResult.stats.total}</div>
                    <div className="text-xs text-gray-500">总行数</div>
                  </div>
                  <div className="bg-green-50 rounded p-2">
                    <div className="text-lg font-semibold text-green-700">{importResult.stats.exactMatch}</div>
                    <div className="text-xs text-green-600">精确匹配</div>
                  </div>
                  <div className="bg-yellow-50 rounded p-2">
                    <div className="text-lg font-semibold text-yellow-700">{importResult.stats.fuzzyMatch}</div>
                    <div className="text-xs text-yellow-600">模糊匹配</div>
                  </div>
                  <div className="bg-red-50 rounded p-2">
                    <div className="text-lg font-semibold text-red-600">{importResult.stats.noMatch}</div>
                    <div className="text-xs text-red-500">未匹配</div>
                  </div>
                </div>

                {importResult.createdPO && (
                  <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">
                    <span className="text-green-700">已创建草稿：</span>
                    <button
                      onClick={() => { setShowImportDialog(false); router.push(`purchases/${importResult.createdPO!.id}`) }}
                      className="font-medium underline"
                      style={{ color: '#875A7B' }}
                    >
                      {importResult.createdPO.name}
                    </button>
                  </div>
                )}

                <div className="flex-1 overflow-auto border border-gray-200 rounded">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-3 py-2 text-left font-medium text-gray-500">原始商品名</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500">数量</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500">单价</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500">匹配结果</th>
                        <th className="px-3 py-2 text-center font-medium text-gray-500">置信度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.lines.map((line, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="px-3 py-1.5 text-gray-700">{line.rawProductName}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700">{line.quantity}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700">{line.unitCost.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-gray-600">{line.matchedProductName ?? '-'}</td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                              line.confidence === 'exact' ? 'bg-green-100 text-green-700' :
                              line.confidence === 'fuzzy' ? 'bg-yellow-100 text-yellow-700' :
                              'bg-red-100 text-red-600'
                            }`}>
                              {line.confidence === 'exact' ? '精确' : line.confidence === 'fuzzy' ? '模糊' : '未匹配'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setShowImportDialog(false)}
                    className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                  >
                    关闭
                  </button>
                  {importResult.createdPO && (
                    <button
                      onClick={() => { setShowImportDialog(false); router.push(`purchases/${importResult.createdPO!.id}`) }}
                      className="flex-1 py-2 rounded text-sm font-medium text-white"
                      style={{ background: '#875A7B' }}
                    >
                      查看采购单
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
