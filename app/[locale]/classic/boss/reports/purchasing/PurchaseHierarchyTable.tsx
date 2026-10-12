'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { apiPost } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { bucketLabel } from '@/lib/reports/date-label'
import type { FilterSpec, ReportRequest } from '@/lib/reports/types'
import { nextDay } from './date-range'

const PURPLE = '#875A7B'
const COUNTED_STATUSES = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']
const ROW_LIMIT = 10000
type Layout = 'product-date' | 'date-supplier-product'
type ApiRow = Record<string, string | number | null | undefined>
type Node = { key: string; label: string; amount: number; qty: number; children: Node[] }

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

export default function PurchaseHierarchyTable({
  isEn, supplierIds, productIds, supplierTerms, from, to,
}: {
  isEn: boolean
  supplierIds: string[]
  productIds: string[]
  supplierTerms: string[]
  from: string
  to: string
}) {
  const [layout, setLayout] = useState<Layout>('product-date')
  const [productKeyword, setProductKeyword] = useState('')
  const [result, setResult] = useState<{ scope: string; rows: ApiRow[]; total: number } | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const scope = [layout, supplierIds.join(','), productIds.join(','), supplierTerms.join(','), productKeyword.trim(), from, to].join('|')

  useEffect(() => {
    let cancelled = false
    setError('')
    const filters: FilterSpec[] = [
      { field: 'order_date', operator: '>=', value: from },
      { field: 'order_date', operator: '<', value: nextDay(to) },
      { field: 'po_status', operator: 'in', value: COUNTED_STATUSES },
    ]
    if (supplierIds.length) filters.push({ field: 'supplier_id', operator: 'in', value: supplierIds })
    if (productIds.length) filters.push({ field: 'product_id', operator: 'in', value: productIds })
    if (productKeyword.trim()) filters.push({ field: 'product_name', operator: 'like', value: productKeyword.trim() })
    const dims = layout === 'product-date'
      ? [{ field: 'product_name' }, { field: 'order_date', interval: 'day' as const }]
      : [{ field: 'order_date', interval: 'day' as const }, { field: 'supplier_name' }, { field: 'product_name' }]
    const request: ReportRequest = {
      rowDimensions: dims, measures: ['subtotal_ex_tax', 'ordered_qty'], filters,
      orFilters: supplierTerms.map((term) => ({ field: 'supplier_name', operator: 'like', value: term })),
      limit: ROW_LIMIT,
    }
    apiPost<{ rows: ApiRow[]; total: number }>('/api/reports/purchasing', request)
      .then((res) => { if (!cancelled) setResult({ scope, rows: res.rows, total: res.total }) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [scope, layout, supplierIds, productIds, productKeyword, from, to])

  const tree = useMemo(() => {
    if (result?.scope !== scope) return [] as Node[]
    const root = new Map<string, Node>()
    const fields = layout === 'product-date' ? ['product_name', 'order_date_day'] : ['order_date_day', 'supplier_name', 'product_name']
    for (const row of result.rows) {
      let level = root
      fields.forEach((field, index) => {
        const raw = row[field]
        const value = field === 'order_date_day' ? dateKey(raw) : String(raw ?? '')
        const label = value || (field === 'supplier_name'
          ? (isEn ? '(unknown supplier)' : '（未知供应商）')
          : field === 'product_name' ? (isEn ? '(unknown product)' : '（未知产品）') : formatDate('', isEn))
        const id = `${field}:${value}`
        let node = level.get(id)
        if (!node) { node = { key: id, label: field === 'order_date_day' ? formatDate(value, isEn) : label, amount: 0, qty: 0, children: [] }; level.set(id, node) }
        node.amount += numeric(row.subtotal_ex_tax)
        node.qty += numeric(row.ordered_qty)
        if (index < fields.length - 1) {
          const children = new Map(node.children.map((child) => [child.key, child]))
          node.children = Array.from(children.values())
          // Keep a map for the next level while retaining the serializable tree shape.
          const childMap = (node as Node & { childMap?: Map<string, Node> }).childMap ?? new Map<string, Node>()
          ;(node as Node & { childMap?: Map<string, Node> }).childMap = childMap
          level = childMap
        }
      })
    }
    const materialize = (map: Map<string, Node>): Node[] => Array.from(map.values()).map((node) => {
      const childMap = (node as Node & { childMap?: Map<string, Node> }).childMap
      node.children = childMap ? materialize(childMap) : []
      delete (node as Node & { childMap?: Map<string, Node> }).childMap
      node.children.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
      return node
    }).sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
    return materialize(root)
  }, [result, scope, layout, isEn])

  const pending = result?.scope !== scope && !error
  const totalAmount = tree.reduce((s, n) => s + n.amount, 0)
  const totalQty = tree.reduce((s, n) => s + n.qty, 0)
  const label = layout === 'product-date'
    ? (isEn ? 'Product → Date' : '产品 → 日期')
    : (isEn ? 'Date → Supplier → Product' : '日期 → 供应商 → 产品')

  function renderNodes(nodes: Node[], depth = 0): React.ReactNode {
    return nodes.map((node) => {
      const expanded = !!open[node.key]
      const expandable = node.children.length > 0
      return <Fragment key={node.key}>
        <tr className="border-b border-gray-50 hover:bg-gray-50">
          <td className="px-3 py-2 whitespace-nowrap" style={{ paddingLeft: 12 + depth * 24 }}>
            {expandable ? <button type="button" onClick={() => setOpen((old) => ({ ...old, [node.key]: !old[node.key] }))} className="w-5 text-purple-800">{expanded ? '−' : '+'}</button> : <span className="inline-block w-5" />}
            {node.label}
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
        {(['product-date', 'date-supplier-product'] as const).map((value) => <button key={value} type="button" onClick={() => { setLayout(value); setOpen({}) }} className="px-3 py-1.5 rounded-lg border text-sm" style={layout === value ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { background: 'white', color: '#4b5563' }}>{value === 'product-date' ? (isEn ? 'Product → Date' : '产品 → 日期') : (isEn ? 'Date → Supplier → Product' : '日期 → 供应商 → 产品')}</button>)}
      </div>
      <div className="flex items-center gap-3">
        <input value={productKeyword} onChange={(e) => setProductKeyword(e.target.value)} placeholder={isEn ? 'Search products by keyword' : '按关键词搜索产品'} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-52" />
        <span className="text-xs text-gray-400">{isEn ? `By order date · ${label}` : `按下单日期统计 · ${label}`}</span>
      </div>
    </div>
    {pending ? <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div> : error ? <div className="py-12 text-center text-sm text-red-500">{error}</div> : <div className="overflow-auto max-h-[70vh]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50 text-gray-600"><tr>
          <th className="text-left px-3 py-2">{isEn ? 'Product / Date / Supplier' : '产品 / 日期 / 供应商'}</th><th className="text-right px-3 py-2">{isEn ? 'Amount' : '金额'}</th><th className="text-right px-3 py-2">{isEn ? 'Quantity' : '数量'}</th><th className="text-right px-3 py-2">{isEn ? 'Average Price' : '平均价格'}</th>
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
