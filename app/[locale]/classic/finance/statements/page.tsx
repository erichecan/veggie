'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { formatDateOnly, formatDateTime } from '@/lib/format-date'

interface Statement {
  id: string
  customerId: string
  customerName: string
  periodStart: string
  periodEnd: string
  openingBalance: number
  totalSales: number
  totalPayments: number
  closingBalance: number
  status: string
  createdAt: string
  sentAt: string | null
}

interface Customer {
  id: string
  name: string
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  sent: '已发送',
}
const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  confirmed: 'bg-blue-50 text-blue-700',
  sent: 'bg-green-50 text-green-700',
}

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'confirmed', label: '已确认' },
  { key: 'sent', label: '已发送' },
]

const PAGE_SIZE = 50

export default function StatementsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [items, setItems] = useState<Statement[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Create dialog
  const [showCreate, setShowCreate] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [formCustomerId, setFormCustomerId] = useState('')
  const [formStart, setFormStart] = useState('')
  const [formEnd, setFormEnd] = useState('')
  const [creating, setCreating] = useState(false)

  // Detail view
  const [detail, setDetail] = useState<Statement | null>(null)
  const [updating, setUpdating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      const data = await apiGet<{ items: Statement[]; total: number }>(`/api/statements?${params}`)
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, page])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    apiGet<{ items: Customer[] }>('/api/customers?limit=500')
      .then(d => setCustomers(d.items ?? []))
      .catch(() => {})
  }, [])

  function handleTabChange(tab: string) {
    setActiveTab(tab)
    setPage(1)
  }

  async function handleCreate() {
    if (!formCustomerId || !formStart || !formEnd) {
      toast.error('请填写完整信息')
      return
    }
    setCreating(true)
    try {
      await apiPost('/api/statements', {
        customerId: formCustomerId,
        periodStart: formStart,
        periodEnd: formEnd,
      })
      toast.success('对账单已生成')
      setShowCreate(false)
      setFormCustomerId('')
      setFormStart('')
      setFormEnd('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  async function handleStatusChange(id: string, newStatus: string) {
    setUpdating(true)
    try {
      const updated = await apiPut<Statement>(`/api/statements/${id}`, { status: newStatus })
      toast.success(`状态已更新为 ${STATUS_LABEL[newStatus] ?? newStatus}`)
      if (detail?.id === id) setDetail(updated)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setUpdating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除此对账单？')) return
    try {
      await apiDelete(`/api/statements/${id}`)
      toast.success('已删除')
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Detail view
  if (detail) {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <OdooControlPanel
          breadcrumb={['财务', '对账单', detail.customerName]}
          permanentActions={[
            { label: '← 返回', onClick: () => setDetail(null) },
            ...(detail.status === 'draft' ? [
              { label: '确认', onClick: () => handleStatusChange(detail.id, 'confirmed'), primary: true },
              { label: '删除', onClick: () => handleDelete(detail.id) },
            ] : []),
            ...(detail.status === 'confirmed' ? [
              { label: '发送', onClick: () => handleStatusChange(detail.id, 'sent'), primary: true },
              { label: '退回草稿', onClick: () => handleStatusChange(detail.id, 'draft') },
            ] : []),
          ]}
          searchValue=""
          onSearch={() => {}}
        />

        <div className="p-6 space-y-6">
          {/* Status badge */}
          <div className="flex items-center gap-3">
            <span className={`inline-block px-3 py-1 rounded text-sm font-medium ${STATUS_COLOR[detail.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[detail.status] ?? detail.status}
            </span>
            {updating && <span className="text-xs text-gray-400">更新中...</span>}
          </div>

          {/* Info cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InfoCard label="客户" value={detail.customerName} />
            <InfoCard label="账期" value={`${fmtDate(detail.periodStart)} ~ ${fmtDate(detail.periodEnd)}`} />
            <InfoCard label="创建时间" value={fmtDateTime(detail.createdAt)} />
            {detail.sentAt && <InfoCard label="发送时间" value={fmtDateTime(detail.sentAt)} />}
          </div>

          {/* Financial summary */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 font-medium text-gray-700">财务汇总</div>
            <div className="divide-y divide-gray-100">
              <FinanceRow label="期初余额" amount={detail.openingBalance} />
              <FinanceRow label="+ 本期销售额" amount={detail.totalSales} positive />
              <FinanceRow label="- 本期付款额" amount={detail.totalPayments} negative />
              <FinanceRow label="期末余额" amount={detail.closingBalance} bold />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <OdooControlPanel
        breadcrumb={['财务', '对账单']}
        permanentActions={[
          { label: '生成对账单', onClick: () => setShowCreate(true), primary: true },
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

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">暂无对账单</div>
        ) : (
          <table className="w-full text-sm border-collapse bg-white">
            <thead>
              <tr className="border-b border-gray-200" style={{ background: '#f9f9f9' }}>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">客户</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">账期</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">期初余额</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">销售额</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">付款额</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">期末余额</th>
                <th className="px-4 py-2.5 text-center font-medium text-gray-500 text-xs">状态</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => (
                <tr
                  key={s.id}
                  onClick={() => setDetail(s)}
                  className="cursor-pointer border-b border-gray-100 hover:bg-blue-50 transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium" style={{ color: '#875A7B' }}>{s.customerName}</td>
                  <td className="px-4 py-2.5 text-gray-600">
                    {fmtDate(s.periodStart)} ~ {fmtDate(s.periodEnd)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-600">€{s.openingBalance.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right text-green-700">€{s.totalSales.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right text-blue-700">€{s.totalPayments.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-gray-900">€{s.closingBalance.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLOR[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABEL[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">
                    {fmtDateTime(s.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">生成对账单</h2>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">客户</label>
              <select
                value={formCustomerId}
                onChange={e => setFormCustomerId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              >
                <option value="">请选择客户...</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">开始日期</label>
                <input
                  type="date"
                  value={formStart}
                  onChange={e => setFormStart(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">结束日期</label>
                <input
                  type="date"
                  value={formEnd}
                  onChange={e => setFormEnd(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setShowCreate(false); setFormCustomerId(''); setFormStart(''); setFormEnd('') }}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !formCustomerId || !formStart || !formEnd}
                className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {creating ? '生成中...' : '生成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtDate(iso: string) {
  if (!iso) return '-'
  return formatDateOnly(iso)
}

function fmtDateTime(iso: string) {
  if (!iso) return '-'
  return formatDateTime(iso)
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-sm font-medium text-gray-800">{value}</div>
    </div>
  )
}

function FinanceRow({ label, amount, positive, negative, bold }: {
  label: string; amount: number; positive?: boolean; negative?: boolean; bold?: boolean
}) {
  return (
    <div className={`flex items-center justify-between px-5 py-3 ${bold ? 'bg-gray-50' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
      <span className={`text-sm ${
        bold ? 'font-bold text-gray-900 text-base'
        : positive ? 'text-green-700'
        : negative ? 'text-blue-700'
        : 'text-gray-700'
      }`}>
        €{amount.toFixed(2)}
      </span>
    </div>
  )
}

