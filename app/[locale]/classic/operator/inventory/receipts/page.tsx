'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface GoodsReceipt {
  id: string
  name: string
  purchaseOrderId: string
  arrivedAt: string
  receivedBy?: string | null
  notes?: string | null
  lines: Array<{ productId: string; productName: string; qty: number; condition: string }>
  createdAt: string
  purchaseOrder?: { id: string; name: string; supplierId: string } | null
}

const PAGE_SIZE = 50

export default function InventoryReceiptsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const [items, setItems] = useState<GoodsReceipt[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String((page - 1) * PAGE_SIZE))
      if (search) params.set('search', search)
      const data = await apiGet<{ items: GoodsReceipt[]; total: number }>(`/api/goods-receipts?${params}`)
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [page, search])

  useEffect(() => { load() }, [load])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(searchInput)
    setPage(1)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Goods Receipts' : '收货单'}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Goods Receipts' : '收货单列表'}</h1>
        <button
          onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
          className="px-4 py-1.5 rounded text-sm font-medium text-white"
          style={{ background: PURPLE }}
        >
          {isEn ? 'Receive via Purchase Order' : '去采购单收货'}
        </button>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={isEn ? 'Search receipt no. or purchase order no....' : '搜索收货单号或采购单号...'}
          className="border rounded px-3 py-1.5 text-sm flex-1 outline-none focus:ring-1"
          style={{ borderColor: BORDER, ['--tw-ring-color' as string]: PURPLE }}
        />
        <button type="submit" className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          {isEn ? 'Search' : '搜索'}
        </button>
        {search && (
          <button type="button" onClick={() => { setSearch(''); setSearchInput(''); setPage(1) }} className="px-3 py-1.5 rounded text-sm text-gray-500 border" style={{ borderColor: BORDER }}>
            {isEn ? 'Clear' : '清除'}
          </button>
        )}
      </form>

      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        {/* Table header */}
        <div className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
          style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '140px 140px 110px 1fr 100px 100px' }}>
          <span>{isEn ? 'Receipt No.' : '收货单号'}</span>
          <span>{isEn ? 'Source PO' : '来源采购单'}</span>
          <span>{isEn ? 'Arrival Date' : '到货日期'}</span>
          <span>{isEn ? 'Contents' : '收货内容'}</span>
          <span>{isEn ? 'Received By' : '收货人'}</span>
          <span>{isEn ? 'Status' : '状态'}</span>
        </div>

        {loading && (
          <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>
        )}

        {!loading && items.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">
            {search
              ? (isEn ? `No goods receipts found for "${search}"` : `未找到"${search}"相关收货单`)
              : (isEn ? 'No goods receipts yet' : '暂无收货记录')}
          </div>
        )}

        {!loading && items.map((item) => {
          const lines = Array.isArray(item.lines) ? item.lines : []
          const linesSummary = lines.length > 0
            ? lines.slice(0, 2).map(l => l.productName).join(isEn ? ', ' : '、') + (lines.length > 2 ? (isEn ? ` +${lines.length} items` : ` 等${lines.length}种`) : '')
            : (isEn ? '(No line items)' : '（无商品行）')
          return (
            <div
              key={item.id}
              className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center hover:bg-[#875A7B]/20 cursor-pointer transition-colors"
              style={{ borderColor: '#f0e4ee', gridTemplateColumns: '140px 140px 110px 1fr 100px 100px' }}
              onClick={() => router.push(`${prefix}/classic/operator/purchases/${item.purchaseOrderId}`)}
            >
              <span className="font-mono text-sm font-semibold" style={{ color: PURPLE }}>{item.name}</span>
              <span className="text-sm text-gray-600">{item.purchaseOrder?.name ?? '—'}</span>
              <span className="text-sm text-gray-600">{formatDateOnly(item.arrivedAt)}</span>
              <span className="text-xs text-gray-500 truncate">{linesSummary}</span>
              <span className="text-sm text-gray-600">{item.receivedBy ?? '—'}</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                {isEn ? 'Completed' : '已完成'}
              </span>
            </div>
          )
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>{isEn ? `${total} total` : `共 ${total} 条`}</span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1 rounded border disabled:opacity-40"
              style={{ borderColor: BORDER }}
            >
              {isEn ? 'Previous' : '上一页'}
            </button>
            <span className="px-3 py-1">{isEn ? `Page ${page} / ${totalPages}` : `第 ${page} / ${totalPages} 页`}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1 rounded border disabled:opacity-40"
              style={{ borderColor: BORDER }}
            >
              {isEn ? 'Next' : '下一页'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
