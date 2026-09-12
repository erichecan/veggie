'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPatch } from '@/lib/api'
import type { SaleUnitRow } from '@/lib/types'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import { Pagination } from '@/components/ui/pagination'
import { BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'

const PAGE_SIZE = 50

/**
 * 商品列表页(app/[locale]/classic/operator/products/page.tsx)一个商品一行，
 * 可售单位摘要塞进「Pack Sequence」列点开的弹窗——客户反馈看不直观（几轮讨论后
 * 定的这版方案：反过来，一个可售单位一行，同一商品的多个单位连续几行排开）。
 *
 * 售价/成本价/提成价是按该单位实际换算出来的展示值（GET /api/products/by-sale-unit
 * 已经用 lib/sale-uom.ts 的 priceOf/commissionPriceOf 算好），这里不重算、不可编辑——
 * 那几个字段背后是 priceMode 三态公式，编辑入口仍然是商品列表页点开的可售单位弹窗。
 * 这一页只能行内编辑三个无歧义的单值字段：规格(spec)/毛重(grossWeight)/装货顺序(sequence)。
 */
export default function ProductsBySaleUnitPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [rows, setRows] = useState<SaleUnitRow[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function loadPage(p: number, q: string, sk: string | null = sortKey, sd: 'asc' | 'desc' = sortDir) {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(p))
      params.set('pageSize', String(PAGE_SIZE))
      if (q) params.set('search', q)
      if (sk) { params.set('sortKey', sk); params.set('sortDir', sd) }
      const res = await apiGet<{ data: SaleUnitRow[]; total: number; page: number; totalPages: number }>(
        `/api/products/by-sale-unit?${params}`,
      )
      setRows(res.data)
      setTotal(res.total)
      setPage(res.page)
      setTotalPages(res.totalPages)

      // Qty Forecast 实时值：跟商品列表页同一套口径(/api/products/forecast)，
      // 只补在默认单位那一行(qtyOnHand 不为 null 的行)，其余单位行保持留空。
      const ids = [...new Set(res.data.filter(r => r.qtyOnHand != null).map(r => r.productId))]
      if (ids.length > 0) {
        apiGet<{ productId: string; forecast: number; qtyOnHand: number }[]>(`/api/products/forecast?ids=${ids.join(',')}`)
          .then(fc => {
            const m = new Map(fc.map(f => [f.productId, f]))
            setRows(prev => prev.map(r => {
              if (r.qtyOnHand == null) return r
              const hit = m.get(r.productId)
              return hit ? { ...r, qtyOnHand: hit.qtyOnHand, qtyForecast: hit.forecast } : r
            }))
          }).catch(() => {})
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadPage(1, '') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timer = setTimeout(() => loadPage(1, searchInput), 400)
    return () => clearTimeout(timer)
  }, [searchInput]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSort(key: string) {
    const nextDir = key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
    setSortKey(key)
    setSortDir(nextDir)
    loadPage(1, searchInput, key, nextDir)
  }

  async function handleCellEdit(row: Record<string, unknown>, key: string, newValue: unknown) {
    const r = row as unknown as SaleUnitRow
    if (!r.uomId) {
      toast.error(isEn ? 'This product has no configured sale unit to edit' : '该商品还没配置可售单位，无法在这里编辑')
      throw new Error('no uomId')
    }
    const fieldMap: Record<string, string> = { spec: 'spec', grossWeight: 'grossWeight', packSequence: 'sequence' }
    const apiField = fieldMap[key]
    if (!apiField) return
    let payloadVal: unknown = newValue
    if (key === 'grossWeight' || key === 'packSequence') {
      if (newValue === '' || newValue == null) {
        payloadVal = null
      } else {
        const n = Number(newValue)
        if (!Number.isFinite(n) || (key === 'grossWeight' && n < 0)) {
          toast.error(isEn ? 'Please enter a valid number' : '请输入合法的数字')
          throw new Error('invalid number')
        }
        payloadVal = n
      }
    }
    try {
      const updated = await apiPatch<{ spec: string | null; sequence: number | null; grossWeight: number | string | null; updatedAt: string; updatedBy: string | null }>(
        `/api/products/${r.productId}/sale-uoms/${r.uomId}`,
        { [apiField]: payloadVal },
      )
      setRows(prev => prev.map(row => row.rowId === r.rowId ? {
        ...row,
        spec: updated.spec,
        packSequence: updated.sequence,
        grossWeight: updated.grossWeight != null ? Number(updated.grossWeight) : null,
        updatedAt: updated.updatedAt,
        updatedBy: updated.updatedBy,
      } : row))
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      throw e
    }
  }

  // 同一商品的连续几行用极浅的交替底色区分开——不改变截图指定的"平铺一行一个单位"
  // 结构，只是让人一眼看出"这几行是同一个商品"，呼应这页要解决的"看不直观"诉求。
  const productIdToBand = new Map<string, number>()
  let nextBand = 0
  for (const r of rows) {
    if (!productIdToBand.has(r.productId)) productIdToBand.set(r.productId, nextBand++)
  }
  function getRowStyle(row: Record<string, unknown>) {
    const r = row as unknown as SaleUnitRow
    const band = productIdToBand.get(r.productId) ?? 0
    return band % 2 === 1 ? { background: '#faf8fb' } : undefined
  }

  const emptyDash = <span className="text-gray-300">—</span>
  // 可售单位行相对基准商品行缩进——是这次改动要解决的"看不出从属关系"问题的核心：
  // 光靠交替底色分组还不够直观，非默认单位行的名称往右缩进一截，一眼就能看出
  // "这几行是同一个商品拆出来的可售单位"，不是平行无关的商品。
  function renderName(v: unknown, row: Record<string, unknown>) {
    const r = row as unknown as SaleUnitRow
    return (
      <span className="text-xs" style={{ paddingLeft: r.isDefault ? 0 : 20 }}>
        {!r.isDefault && <span className="text-gray-300 mr-1">↳</span>}
        {String(v ?? '')}
      </span>
    )
  }
  const columns: OdooColumn<Record<string, unknown>>[] = [
    { key: 'internalRef', label: isEn ? 'Internal Reference' : '内部编号', width: 90, sortable: true,
      render: v => v ? <span className="text-xs">{String(v)}</span> : emptyDash },
    { key: 'name', label: isEn ? 'Name' : '名称', minWidth: 200, sortable: true,
      render: renderName },
    { key: 'saleDescription', label: isEn ? 'Sale Description' : '销售描述', minWidth: 140, sortable: true,
      render: v => v ? <span className="text-xs text-gray-500">{String(v)}</span> : emptyDash },
    { key: 'spec', label: isEn ? 'Product Spec' : '产品规格', width: 110, sortable: true, editable: true, editType: 'text',
      render: v => v ? <span className="text-xs">{String(v)}</span> : emptyDash },
    { key: 'uomName', label: 'UoM', width: 80, sortable: true,
      render: v => v ? <span className="text-xs font-medium">{String(v)}</span> : emptyDash },
    { key: 'salePrice', label: isEn ? 'Sale Price' : '售价', width: 80, sortable: true,
      render: v => <span className="text-xs">€{Number(v).toFixed(2)}</span> },
    { key: 'customerTaxRate', label: isEn ? 'Customer Tax' : '客户税率', width: 70, sortable: true,
      render: v => v != null ? <span className="text-xs">{(Number(v) * 100).toFixed(1)}%</span> : emptyDash },
    { key: 'costPrice', label: isEn ? 'Cost Price' : '成本价', width: 80, sortable: true,
      render: v => <span className="text-xs text-gray-500">€{Number(v).toFixed(2)}</span> },
    { key: 'vendorTaxRate', label: isEn ? 'Vendor Tax' : '供应商税率', width: 70, sortable: true,
      render: v => v != null ? <span className="text-xs">{(Number(v) * 100).toFixed(1)}%</span> : emptyDash },
    { key: 'grossWeight', label: isEn ? 'Gross Weight (kg)' : '毛重(kg)', width: 90, sortable: true, editable: true, editType: 'number',
      render: v => v != null ? <span className="text-xs">{Number(v).toFixed(2)}</span> : emptyDash },
    { key: 'qtyOnHand', label: isEn ? 'QTY On Hand' : '现有库存', width: 80, sortable: true,
      render: v => v != null ? <span className="text-xs">{Number(v).toFixed(1)}</span> : emptyDash },
    { key: 'qtyForecast', label: isEn ? 'QTY Forecast' : '预测库存', width: 80,
      render: v => v != null ? <span className="text-xs">{Number(v).toFixed(1)}</span> : emptyDash },
    { key: 'category', label: isEn ? 'Product Category' : '商品类别', width: 100, sortable: true,
      render: v => v ? <span className="text-xs">{String(v)}</span> : emptyDash },
    { key: 'packSequence', label: isEn ? 'Pack Sequence' : '装货顺序', width: 80, sortable: true, editable: true, editType: 'number',
      render: v => v != null ? <span className="text-xs">{String(v)}</span> : emptyDash },
    { key: 'commissionPrice', label: isEn ? 'CMS Price' : '提成价', width: 80, sortable: true,
      render: v => v != null ? <span className="text-xs text-gray-500">€{Number(v).toFixed(2)}</span> : emptyDash },
    { key: 'updatedAt', label: isEn ? 'Last Updated on' : '最后更新时间', width: 90, sortable: true, sortKey: 'suUpdatedAt',
      render: v => v ? <span className="text-xs text-gray-500">{new Date(String(v)).toLocaleDateString('en-GB', { timeZone: BUSINESS_TIMEZONE })}</span> : emptyDash },
    { key: 'updatedBy', label: isEn ? 'Last Updated by' : '最后更新人', width: 90, sortable: true,
      render: v => v ? <span className="text-xs text-gray-500">{String(v)}</span> : emptyDash },
  ]

  return (
    <div>
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push(`${prefix}/classic/operator/products`)}
          className="h-8 px-3 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        >
          ← {isEn ? 'Back to Products' : '返回商品列表'}
        </button>
        <div className="text-sm text-gray-400">/</div>
        <div className="text-sm font-medium text-gray-700">
          {isEn ? 'Products by Sale Unit' : '按可售单位查看商品'}
        </div>
      </div>

      <div className="px-4 pb-2">
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={isEn ? 'Search name / internal ref / spec...' : '搜索名称/内部编号/规格...'}
          className="h-8 w-72 px-3 text-sm border border-gray-300 rounded focus:outline-none focus:border-[#875A7B] focus:ring-1 focus:ring-[#875A7B]"
        />
        <span className="ml-3 text-xs text-gray-400">
          {isEn ? `${total} products` : `共 ${total} 个商品`}
        </span>
      </div>

      <div className="p-4 pt-0 overflow-x-auto">
        <OdooTable
          columns={columns}
          rows={rows as unknown as Record<string, unknown>[]}
          rowKey="rowId"
          loading={loading}
          getRowStyle={getRowStyle}
          inlineEditEnabled
          onCellEdit={handleCellEdit}
          sortKey={sortKey ?? undefined}
          sortDir={sortDir}
          onSort={handleSort}
          emptyText={isEn ? 'No products found' : '没有找到商品'}
        />
      </div>

      <div className="px-4 pb-6">
        <Pagination page={page} totalPages={totalPages} onPageChange={p => loadPage(p, searchInput)} />
      </div>
    </div>
  )
}
