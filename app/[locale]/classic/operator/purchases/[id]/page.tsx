'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPatch, authHeaders } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'

async function openPurchaseOrderPdf(poId: string) {
  // JWT 存在 localStorage，直接 window.open API 路由不会带 Authorization 头会 401，
  // 必须先用带鉴权的 fetch 取回 HTML 文本，再开新窗口写入。
  const win = window.open('', '_blank')
  try {
    const res = await fetch(`/api/purchase-orders/${poId}/pdf`, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    if (win) {
      win.document.open()
      win.document.write(html)
      win.document.close()
    }
  } catch (e) {
    win?.close()
    toast.error(e instanceof Error ? e.message : 'PDF 生成失败')
  }
}

const PURPLE = '#875A7B'
const DARK = '#1f2d3d'

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface POLine {
  id: string
  sequence: number
  productId?: string | null
  productName: string
  spec?: string | null
  uomName?: string | null
  orderedQty: number
  unitCost: number
  taxRate: number
  bestBefore?: string | null
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
}

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
  orderDate: string
  expectedDate?: string | null
  notes?: string | null
  lockedAt?: string | null
  editApprovalRequired?: boolean
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  createdAt: string
  lines: POLine[]
}

interface Supplier {
  id: string
  name: string
}

function toInputDate(iso?: string | null) {
  if (!iso) return ''
  try { return new Date(iso).toISOString().slice(0, 10) } catch { return '' }
}

function OdooStatusBar({ status }: { status: POStatus }) {
  const steps = [
    { label: '询价单', statuses: ['DRAFT'] as POStatus[] },
    { label: '询价单已发送', statuses: ['SENT', 'TO_APPROVE'] as POStatus[] },
    { label: '采购订单', statuses: ['CONFIRMED', 'RECEIVED', 'INVOICED'] as POStatus[] },
    { label: '已锁定', statuses: ['LOCKED'] as POStatus[] },
  ]
  const activeIdx = steps.findIndex(s => s.statuses.includes(status))

  if (status === 'CANCELLED') {
    return (
      <span className="px-4 py-1 text-sm font-medium rounded-full" style={{ background: '#fef2f2', color: '#dc2626' }}>
        已取消
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'TO_APPROVE' && (
        <span className="px-3 py-1 text-xs font-medium rounded-full" style={{ background: '#fef3cd', color: '#856404' }}>
          待审批
        </span>
      )}
      <div className="flex items-stretch gap-0" style={{ height: '28px' }}>
        {steps.map((step, i) => {
          const isActive = i === activeIdx
          const isPast = i < activeIdx
          const bg = isActive ? PURPLE : isPast ? '#c8b0d0' : '#ede7f0'
          const color = isActive ? 'white' : isPast ? '#5a3060' : '#9d7ab0'
          const paddingLeft = i === 0 ? 'pl-5' : 'pl-8'

          return (
            <div
              key={step.label}
              className={`relative flex items-center ${paddingLeft} pr-5 text-xs font-medium select-none`}
              style={{
                background: bg,
                color,
                clipPath: i === 0
                  ? 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%)'
                  : i === steps.length - 1
                  ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 11px 50%)'
                  : 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%, 11px 50%)',
                marginLeft: i > 0 ? '-1px' : '0',
              }}
            >
              {isActive && <span className="mr-1.5 text-xs">●</span>}
              {step.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function PurchaseDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const params = useParams<{ id: string }>()
  const id = params.id

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState(false)
  const [activeTab, setActiveTab] = useState<'products' | 'other'>('products')

  const [editNotes, setEditNotes] = useState('')
  const [editExpectedDate, setEditExpectedDate] = useState('')
  const [editSupplierId, setEditSupplierId] = useState('')
  const [editLines, setEditLines] = useState<POLine[]>([])

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<PurchaseOrder>(`/api/purchase-orders/${id}`)
      setPo(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => {
    apiGet<{ items: Supplier[] }>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(d.items ?? (d as unknown as Supplier[])))
      .catch(() => {})
  }, [])

  function startEdit() {
    if (!po) return
    setEditNotes(po.notes ?? '')
    setEditExpectedDate(toInputDate(po.expectedDate))
    setEditSupplierId(po.supplierId)
    setEditLines(po.lines.map(l => ({ ...l })))
    setEditing(true)
  }

  function discardEdit() {
    setEditing(false)
    setEditLines([])
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitCost' | 'taxRate', value: number) {
    setEditLines(prev => {
      const next = [...prev]
      const l = { ...next[idx], [field]: value }
      const qty = field === 'orderedQty' ? value : Number(next[idx].orderedQty)
      const cost = field === 'unitCost' ? value : Number(next[idx].unitCost)
      const tax = field === 'taxRate' ? value : Number(next[idx].taxRate)
      l.subtotalExTax = qty * cost
      l.taxAmount = l.subtotalExTax * tax / 100
      l.subtotalIncTax = l.subtotalExTax + l.taxAmount
      next[idx] = l
      return next
    })
  }

  async function handleSave() {
    if (!po) return
    setSaving(true)
    try {
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, {
        notes: editNotes || null,
        expectedDate: editExpectedDate || null,
        supplierId: editSupplierId,
        lines: editLines.map(l => ({
          id: l.id,
          orderedQty: Number(l.orderedQty),
          unitCost: Number(l.unitCost),
          taxRate: Number(l.taxRate),
          bestBefore: l.bestBefore || null,
        })),
      })
      setPo(updated)
      setEditing(false)
      setEditLines([])
      toast.success('保存成功')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleAction(action: string, label: string) {
    if (!po || acting) return
    setActing(true)
    try {
      const updated = await apiPatch<PurchaseOrder>(`/api/purchase-orders/${id}`, { action })
      setPo(updated)
      toast.success(`${label}成功`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label}失败`)
    } finally {
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        加载中...
      </div>
    )
  }

  if (!po) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">采购单不存在</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50">
          返回列表
        </button>
      </div>
    )
  }

  const isEditable = po.status === 'DRAFT' || po.status === 'SENT'
  const isLocked = po.status === 'LOCKED'
  const isCancelled = po.status === 'CANCELLED'
  const displayLines = editing ? editLines : po.lines

  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotalExTax), 0)
  const totalTax = displayLines.reduce((s, l) => s + Number(l.taxAmount), 0)
  const totalIncTax = displayLines.reduce((s, l) => s + Number(l.subtotalIncTax), 0)

  const supplierName = suppliers.find(s => s.id === (editing ? editSupplierId : po.supplierId))?.name
    ?? po.supplierName ?? po.supplierId

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100'
  const numInputCls = 'border border-gray-300 rounded px-1.5 py-0.5 text-sm bg-white text-right focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

  return (
    <div className="flex flex-col h-full overflow-auto" style={{ background: '#f3f4f5' }}>

      {/* ── Top control bar ─────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 flex-shrink-0">

        {/* Row 1: breadcrumb */}
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="hover:underline"
            style={{ color: PURPLE }}
          >
            询价单
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">{po.name}</span>
        </div>

        {/* Row 2: action buttons + pagination */}
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {!editing ? (
              <>
                <button
                  onClick={startEdit}
                  disabled={!isEditable || isCancelled || isLocked}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: '#d0d5dd', color: DARK, background: 'white' }}
                  onMouseEnter={e => { if (isEditable && !isCancelled && !isLocked) (e.currentTarget as HTMLElement).style.background = '#f5f5f5' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'white' }}
                >
                  编辑
                </button>
                <button
                  onClick={() => { router.push(`${prefix}/classic/operator/purchases`) }}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  新建
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: PURPLE, color: PURPLE, background: 'white' }}
                >
                  {saving ? '保存中…' : '手动保存'}
                </button>
                <button
                  onClick={discardEdit}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  放弃
                </button>
              </>
            )}
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <button onClick={() => openPurchaseOrderPdf(po.id)}
              className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50 flex items-center gap-1"
              style={{ borderColor: '#d0d5dd', color: DARK }}>
              打印
            </button>
            <button className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50 flex items-center gap-1"
              style={{ borderColor: '#d0d5dd', color: DARK }}>
              操作 <span className="text-xs leading-none">▾</span>
            </button>
          </div>

          {/* Pagination stub */}
          <div className="flex items-center gap-1">
            <button className="w-6 h-6 rounded border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-gray-500 text-xs">
              ‹
            </button>
            <button className="w-6 h-6 rounded border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-gray-500 text-xs">
              ›
            </button>
          </div>
        </div>

        {/* Row 3: status action buttons */}
        {!editing && (
          <div className="px-6 py-2.5 border-t border-gray-100 flex items-center gap-2">
            {po.status === 'DRAFT' && (
              <>
                <button onClick={() => handleAction('send', '发送')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  发送邮件
                </button>
                <button onClick={() => openPurchaseOrderPdf(po.id)}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                  打印询价单
                </button>
                <button onClick={() => handleAction('confirm', '确认采购')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  确认采购
                </button>
                <button onClick={() => { if (confirm('确定取消此采购单？')) handleAction('cancel', '取消') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  取消
                </button>
              </>
            )}
            {po.status === 'SENT' && (
              <>
                <button onClick={() => handleAction('confirm', '确认采购')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  确认采购
                </button>
                <button onClick={() => { if (confirm('确定取消此采购单？')) handleAction('cancel', '取消') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  取消
                </button>
              </>
            )}
            {po.status === 'CONFIRMED' && (
              <>
                <button onClick={() => handleAction('receive', '确认收货')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  确认收货
                </button>
                <button onClick={() => { if (confirm('确定取消此采购单？')) handleAction('cancel', '取消') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  取消
                </button>
              </>
            )}
            {po.status === 'RECEIVED' && (
              <button onClick={() => handleAction('invoice', '创建账单')} disabled={acting}
                className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                style={{ background: PURPLE }}>
                创建账单
              </button>
            )}
            {po.status === 'INVOICED' && (
              <button onClick={() => handleAction('lock', '锁定')} disabled={acting}
                className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                style={{ background: PURPLE }}>
                🔒 锁定
              </button>
            )}
            {po.status === 'TO_APPROVE' && (
              <>
                <button onClick={() => handleAction('approve', '审批通过')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: '#16a34a' }}>
                  ✓ 审批通过
                </button>
                <button onClick={() => { if (confirm('确定取消此采购单？')) handleAction('cancel', '取消') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  取消
                </button>
              </>
            )}
            {isLocked && (
              <span className="text-sm font-medium px-3 py-1 rounded flex items-center gap-1.5" style={{ background: '#f0fdf4', color: '#166534' }}>
                🔒 已锁定 — 不可变更
              </span>
            )}
            {isCancelled && (
              <>
                <button onClick={() => handleAction('reset_to_draft', '重置为草稿')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  重置为草稿
                </button>
                <span className="text-sm font-medium px-3 py-1 rounded" style={{ background: '#fef2f2', color: '#dc2626' }}>
                  此采购单已取消
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Status progress bar ──────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-end flex-shrink-0">
        <OdooStatusBar status={po.status} />
      </div>

      {/* ── Main form card ───────────────────────────────── */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="bg-white rounded border border-gray-200 shadow-sm">

          {/* Form header */}
          <div className="px-6 pt-5 pb-4">
            <div className="grid grid-cols-2 gap-10">

              {/* Left column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">供应商</label>
                  {editing ? (
                    <select
                      value={editSupplierId}
                      onChange={e => setEditSupplierId(e.target.value)}
                      className={`flex-1 ${inputCls}`}
                    >
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-sm font-medium" style={{ color: PURPLE }}>{supplierName}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">供应商参考</label>
                  {editing ? (
                    <input type="text" placeholder="供应商的订单参考号" className={`flex-1 ${inputCls}`} />
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">货币</label>
                  <span className="text-sm text-gray-700">CNY</span>
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">订单日期</label>
                  <span className="text-sm text-gray-800">{formatDateOnly(po.orderDate ?? po.createdAt)}</span>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">预期到货日期</label>
                  {editing ? (
                    <input
                      type="date"
                      value={editExpectedDate}
                      onChange={e => setEditExpectedDate(e.target.value)}
                      className={inputCls}
                      style={{ width: '180px' }}
                    />
                  ) : (
                    <span className="text-sm text-gray-800">{formatDateOnly(po.expectedDate) || '—'}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">采购代表</label>
                  <span className="text-sm text-gray-400">—</span>
                </div>
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-t border-b border-gray-200 px-6 bg-gray-50">
            {(['products', 'other'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px"
                style={{
                  borderBottomColor: activeTab === tab ? PURPLE : 'transparent',
                  color: activeTab === tab ? PURPLE : '#6b7280',
                  background: 'transparent',
                }}
              >
                {tab === 'products' ? '产品' : '其他信息'}
              </button>
            ))}
          </div>

          {/* ── Products tab ── */}
          {activeTab === 'products' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">商品</th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">描述</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">数量</th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">单位</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">单价</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">税率%</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">Best Before</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">小计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayLines.map((l, i) => (
                      <tr key={l.id} className="border-b border-gray-100 hover:bg-blue-50/30 transition-colors">
                        <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>{l.productName}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[180px] truncate">{l.spec || ''}</td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.001" min="0"
                              className={numInputCls} style={{ width: '80px' }}
                              value={Number(l.orderedQty)}
                              onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-800">{Number(l.orderedQty).toFixed(3)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{l.uomName || '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.01" min="0"
                              className={numInputCls} style={{ width: '90px' }}
                              value={Number(l.unitCost)}
                              onChange={e => updateLine(i, 'unitCost', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-800">{Number(l.unitCost).toFixed(2)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.1" min="0"
                              className={numInputCls} style={{ width: '60px' }}
                              value={Number(l.taxRate ?? 0)}
                              onChange={e => updateLine(i, 'taxRate', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-600 text-xs">{Number(l.taxRate ?? 0).toFixed(1)}%</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="date"
                              className={`${numInputCls} text-xs`} style={{ width: '120px' }}
                              value={toInputDate(l.bestBefore)}
                              onChange={e => {
                                setEditLines(prev => {
                                  const next = [...prev]
                                  next[i] = { ...next[i], bestBefore: e.target.value || null }
                                  return next
                                })
                              }} />
                          ) : (
                            <span className="text-gray-600 text-xs">{formatDateOnly(l.bestBefore) || '—'}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                          {Number(l.subtotalExTax).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    {displayLines.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-10 text-center text-gray-400 text-sm">暂无明细行</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="border-t border-gray-200 px-6 py-5 flex justify-end">
                <div style={{ minWidth: '280px' }}>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">税前金额</span>
                    <span className="text-gray-800 font-medium">{subtotalExTax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">税额</span>
                    <span className="text-gray-800">{totalTax.toFixed(2)}</span>
                  </div>
                  <div className="border-t border-gray-300 mt-1 pt-2 flex justify-between">
                    <span className="text-sm font-semibold" style={{ color: DARK }}>合计</span>
                    <span className="text-base font-bold" style={{ color: DARK }}>{totalIncTax.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Other Information tab ── */}
          {activeTab === 'other' && (
            <div className="p-6">
              <div className="grid grid-cols-2 gap-10">
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0 pt-1">备注</label>
                    {editing ? (
                      <textarea
                        value={editNotes}
                        onChange={e => setEditNotes(e.target.value)}
                        rows={3}
                        placeholder="内部备注..."
                        className={`flex-1 ${inputCls} resize-none`}
                      />
                    ) : (
                      <span className="text-sm text-gray-700 whitespace-pre-line">{po.notes || '—'}</span>
                    )}
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">来源单据</label>
                    <span className="text-sm text-gray-400">—</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">创建日期</label>
                    <span className="text-sm text-gray-700">{formatDateOnly(po.createdAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Chatter / message area ────────────────────── */}
        <div className="mt-4 bg-white rounded border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-4">
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>✉</span> 发送消息
            </button>
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>📝</span> 记录备注
            </button>
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>📅</span> 安排活动
            </button>
          </div>
          <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded">
            暂无消息记录
          </div>
        </div>
      </div>
    </div>
  )
}
