'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiPost } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import { bucketLabel } from '@/lib/reports/date-label'
import type { FilterSpec, ReportRequest } from '@/lib/reports/types'
import { nextDay } from './date-range'
import { productLabel } from './product-label'

const PURPLE = '#875A7B'
const COUNTED_STATUSES = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']
const ROW_LIMIT = 10000
type Layout = 'product-date-supplier' | 'date-supplier-product'
type ApiRow = Record<string, string | number | null | undefined>
type Node = { key: string; label: string; amount: number; qty: number; children: Node[]; dateKey?: string; childMap?: Map<string, Node>; poId?: string }

/**
 * 每一级分组怎么从扁平行里取值、怎么展示 —— 一个 level 可以对应多个 SQL 维度
 * （商品这一级同时按 product_name/product_spec/description 三个字段 GROUP BY，
 * 但视觉上只算一层），`resolve` 负责把这几个字段揉成一个节点的 key/label。
 */
interface LevelDef {
  requestFields: { field: string; interval?: 'day' }[]
  isDate: boolean
  resolve: (row: ApiRow, isEn: boolean) => { key: string; label: string; dateKey?: string; poId?: string }
}

function dateKey(value: unknown) {
  if (!value) return ''
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10)
}
function formatDate(key: string, isEn: boolean) {
  if (!key) return isEn ? '(no date)' : '（无日期）'
  return bucketLabel(`${key}T00:00:00.000Z`, 'day', isEn)
}
function numeric(v: unknown) { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0 }
function str(v: unknown) { return v == null ? '' : String(v) }

const productLevel: LevelDef = {
  requestFields: [{ field: 'product_name' }, { field: 'product_spec' }, { field: 'description' }],
  isDate: false,
  resolve: (row, isEn) => {
    const name = str(row.product_name)
    const spec = row.product_spec == null ? null : str(row.product_spec)
    const description = row.description == null ? null : str(row.description)
    const label = name ? productLabel(name, spec, description) : (isEn ? '(unknown product)' : '（未知产品）')
    return { key: `product:${name}|${spec ?? ''}|${description ?? ''}`, label }
  },
}
const dateLevel: LevelDef = {
  requestFields: [{ field: 'order_date', interval: 'day' }],
  isDate: true,
  resolve: (row, isEn) => {
    const value = dateKey(row.order_date_day)
    return { key: `date:${value}`, label: formatDate(value, isEn), dateKey: value }
  },
}
const supplierLevel: LevelDef = {
  requestFields: [{ field: 'supplier_name' }],
  isDate: false,
  resolve: (row, isEn) => {
    const value = str(row.supplier_name)
    return { key: `supplier:${value}`, label: value || (isEn ? '(unknown supplier)' : '（未知供应商）') }
  },
}
const poLevel: LevelDef = {
  requestFields: [{ field: 'po_name' }, { field: 'purchase_order_id' }],
  isDate: false,
  resolve: (row, isEn) => {
    const value = str(row.po_name)
    const poId = str(row.purchase_order_id) || undefined
    return { key: `po:${value}`, label: value || (isEn ? '(no PO number)' : '（无单号）'), poId }
  },
}

const LAYOUTS: Record<Layout, LevelDef[]> = {
  // 20261015：客户要求「产品→日期→供应商」，供应商这层展开后还要能看到具体是哪几张 PO
  'product-date-supplier': [productLevel, dateLevel, supplierLevel, poLevel],
  'date-supplier-product': [dateLevel, supplierLevel, productLevel],
}
const LAYOUT_LABEL: Record<Layout, { en: string; zh: string }> = {
  'product-date-supplier': { en: 'Product → Date → Supplier', zh: '产品 → 日期 → 供应商' },
  'date-supplier-product': { en: 'Date → Supplier → Product', zh: '日期 → 供应商 → 产品' },
}

export default function PurchaseHierarchyTable({
  isEn, supplierIds, productIds, supplierTerms, productTerms, from, to,
}: {
  isEn: boolean
  supplierIds: string[]
  productIds: string[]
  supplierTerms: string[]
  productTerms: string[]
  from: string
  to: string
}) {
  const [layout, setLayout] = useState<Layout>('product-date-supplier')
  const [result, setResult] = useState<{ scope: string; rows: ApiRow[]; total: number } | null>(null)
  const [error, setError] = useState<{ scope: string; message: string } | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const scope = [layout, supplierIds.join(','), productIds.join(','), supplierTerms.join(','), productTerms.join(','), from, to].join('|')
  const levels = LAYOUTS[layout]

  useEffect(() => {
    let cancelled = false
    const filters: FilterSpec[] = [
      { field: 'order_date', operator: '>=', value: from },
      { field: 'order_date', operator: '<', value: nextDay(to) },
      { field: 'po_status', operator: 'in', value: COUNTED_STATUSES },
    ]
    if (supplierIds.length) filters.push({ field: 'supplier_id', operator: 'in', value: supplierIds })
    if (productIds.length) filters.push({ field: 'product_id', operator: 'in', value: productIds })
    const dims = levels.flatMap((level) => level.requestFields)
    const request: ReportRequest = {
      rowDimensions: dims, measures: ['subtotal_ex_tax', 'ordered_qty'], filters,
      orFilters: supplierTerms.map((term) => ({ field: 'supplier_name', operator: 'like', value: term })),
      orFilterGroups: productTerms.length ? [productTerms.map((term) => ({ field: 'product_name', operator: 'like' as const, value: term }))] : [],
      limit: ROW_LIMIT,
    }
    apiPost<{ rows: ApiRow[]; total: number }>('/api/reports/purchasing', request)
      .then((res) => { if (!cancelled) setResult({ scope, rows: res.rows, total: res.total }) })
      .catch((e) => { if (!cancelled) setError({ scope, message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [scope, layout, levels, supplierIds, productIds, supplierTerms, productTerms, from, to])

  const tree = useMemo(() => {
    if (result?.scope !== scope) return [] as Node[]
    const root = new Map<string, Node>()
    for (const row of result.rows) {
      let level = root
      levels.forEach((levelDef, index) => {
        const { key, label, dateKey: dk, poId } = levelDef.resolve(row, isEn)
        let node = level.get(key)
        if (!node) { node = { key, label, amount: 0, qty: 0, children: [], dateKey: dk, poId }; level.set(key, node) }
        node.amount += numeric(row.subtotal_ex_tax)
        node.qty += numeric(row.ordered_qty)
        if (index < levels.length - 1) {
          const childMap = node.childMap ?? new Map<string, Node>()
          node.childMap = childMap
          level = childMap
        }
      })
    }
    const materialize = (map: Map<string, Node>, depth: number): Node[] => {
      const arr = Array.from(map.values()).map((node) => {
        node.children = node.childMap ? materialize(node.childMap, depth + 1) : []
        delete node.childMap
        return node
      })
      if (levels[depth]?.isDate) {
        arr.sort((a, b) => (a.dateKey ?? '').localeCompare(b.dateKey ?? ''))
      } else {
        arr.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
      }
      return arr
    }
    return materialize(root, 0)
  }, [result, scope, levels, isEn])

  const errorMessage = error?.scope === scope ? error.message : ''
  const pending = result?.scope !== scope && !errorMessage
  const totalAmount = tree.reduce((s, n) => s + n.amount, 0)
  const totalQty = tree.reduce((s, n) => s + n.qty, 0)
  const label = isEn ? LAYOUT_LABEL[layout].en : LAYOUT_LABEL[layout].zh
  // 顶层按商品分组时，客户要求商品之间加一条分隔线，方便一眼区分不同商品的区块
  const topLevelIsProduct = levels[0] === productLevel

  function exportCsv() {
    const headers = isEn
      ? ['Product / Date / Supplier / PO', 'Amount', 'Quantity', 'Average Price']
      : ['产品 / 日期 / 供应商 / 采购单', '金额', '数量', '平均价格']
    const rows: string[][] = [[
      isEn ? 'Total' : '总计',
      fmtMoney(totalAmount),
      String(Math.round(totalQty * 1000) / 1000),
      fmtMoney(totalQty ? totalAmount / totalQty : 0),
    ]]
    // 只导出屏幕上看得到的：展开到哪一层，就导出到哪一层，跟界面保持一致
    const walk = (nodes: Node[], depth: number) => {
      for (const node of nodes) {
        rows.push([
          `${'    '.repeat(depth)}${node.label}`,
          fmtMoney(node.amount),
          String(Math.round(node.qty * 1000) / 1000),
          fmtMoney(node.qty ? node.amount / node.qty : 0),
        ])
        if (open[node.key] && node.children.length) walk(node.children, depth + 1)
      }
    }
    walk(tree, 0)
    downloadCsv(`purchase-analysis-hierarchy-${layout}-${from}_${to}`, headers, rows)
  }

  function renderNodes(nodes: Node[], depth = 0): React.ReactNode {
    return nodes.map((node, index) => {
      const expanded = !!open[node.key]
      const expandable = node.children.length > 0
      const topSeparator = depth === 0 && topLevelIsProduct && index > 0
      return <Fragment key={node.key}>
        <tr className={`border-b border-gray-50 hover:bg-gray-50${topSeparator ? ' border-t-2 border-t-gray-300' : ''}`}>
          <td className="px-3 py-2 whitespace-nowrap" style={{ paddingLeft: 12 + depth * 24 }}>
            {expandable ? <button type="button" onClick={() => setOpen((old) => ({ ...old, [node.key]: !old[node.key] }))} className="w-5 text-purple-800">{expanded ? '−' : '+'}</button> : <span className="inline-block w-5" />}
            {node.poId
              ? <a href={`${prefix}/classic/operator/purchases/${node.poId}`} target="_blank" rel="noopener noreferrer" className="text-purple-700 hover:underline">{node.label}</a>
              : node.label}
          </td>
          <td className="px-3 py-2 text-right tabular-nums">{eur(node.amount)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{Math.round(node.qty * 1000) / 1000}</td>
          <td className="px-3 py-2 text-right tabular-nums">{node.qty ? eur(node.amount / node.qty) : eur(0)}</td>
        </tr>
        {expanded && renderNodes(node.children, depth + 1)}
      </Fragment>
    })
  }

  return <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-b border-gray-100">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">{isEn ? 'Group by' : '分组方式'}</span>
        {(['product-date-supplier', 'date-supplier-product'] as const).map((value) => <button key={value} type="button" onClick={() => { setLayout(value); setOpen({}) }} className="px-3 py-1.5 rounded-lg border text-sm" style={layout === value ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { background: 'white', color: '#4b5563' }}>{isEn ? LAYOUT_LABEL[value].en : LAYOUT_LABEL[value].zh}</button>)}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">{isEn ? `By order date · ${label}` : `按下单日期统计 · ${label}`}</span>
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
          title={isEn ? 'Export what is on screen, including expanded rows' : '导出当前屏幕上的内容（含已展开的行）'}
        >
          ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
        </button>
      </div>
    </div>
    {pending ? <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div> : errorMessage ? <div className="py-12 text-center text-sm text-red-500">{errorMessage}</div> : <div className="overflow-auto max-h-[70vh]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50 text-gray-600"><tr>
          <th className="text-left px-3 py-2">{isEn ? 'Product / Date / Supplier / PO' : '产品 / 日期 / 供应商 / 采购单'}</th><th className="text-right px-3 py-2">{isEn ? 'Amount' : '金额'}</th><th className="text-right px-3 py-2">{isEn ? 'Quantity' : '数量'}</th><th className="text-right px-3 py-2">{isEn ? 'Average Price' : '平均价格'}</th>
        </tr></thead>
        <tbody>
          <tr className="border-b bg-gray-50 font-semibold"><td className="px-3 py-2">{isEn ? 'Total' : '总计'}</td><td className="px-3 py-2 text-right">{eur(totalAmount)}</td><td className="px-3 py-2 text-right">{Math.round(totalQty * 1000) / 1000}</td><td className="px-3 py-2 text-right">{totalQty ? eur(totalAmount / totalQty) : eur(0)}</td></tr>
          {tree.length ? renderNodes(tree) : <tr><td colSpan={4} className="text-center py-12 text-gray-400">{isEn ? 'No matching products' : '没有匹配的产品'}</td></tr>}
        </tbody>
      </table>
      {result && result.total >= ROW_LIMIT && <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50">{isEn ? 'Result reached the row limit; narrow the dates or product search.' : '结果达到行数上限，请缩短时间范围或增加产品关键词。'}</div>}
    </div>}
  </section>
}
