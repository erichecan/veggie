'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { Invoice } from '@/lib/types'
import { Button } from '@/components/ui/button'
import ActionLogPanel from '@/components/shared/action-log-panel'
import Link from 'next/link'

const PURPLE = '#875A7B'

const STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: '草稿',
  posted: '已确认',
  paid: '已付款',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<Invoice['status'], string> = {
  draft: 'bg-gray-100 text-gray-700',
  posted: 'bg-purple-100 text-purple-700',
  paid: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

export default function ClassicInvoiceDetailPage() {
  const params = useParams()
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [inv, setInv] = useState<Invoice | null>(null)

  async function load() {
    try {
      const found = await apiGet<Invoice>(`/api/invoices/${params.id}`)
      if (!found) { setInv(null); return }
      setInv({ ...found, status: found.status?.toLowerCase() as Invoice['status'] ?? found.status })
    } catch {
      setInv(null)
    }
  }

  useEffect(() => { load() }, [params.id])

  async function handlePost() {
    if (!inv) return
    const updated: Invoice = {
      ...inv,
      status: 'posted',
      postedAt: new Date().toISOString(),
    }
    try {
      await apiPut(`/api/invoices/${inv.id}`, { ...updated, status: 'posted' })
      setInv(updated)
      toast.success('发票已确认（Posted）')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handlePay() {
    if (!inv) return
    const updated: Invoice = {
      ...inv,
      status: 'paid',
      amountPaid: inv.totalIncTax,
      amountDue: 0,
      paidAt: new Date().toISOString(),
    }
    try {
      await apiPut(`/api/invoices/${inv.id}`, { ...updated, status: 'paid' })
      setInv(updated)
      toast.success('已标记为已付款')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleCancel() {
    if (!inv) return
    if (!confirm('确认取消此发票？')) return
    const updated: Invoice = { ...inv, status: 'cancelled' }
    try {
      await apiPut(`/api/invoices/${inv.id}`, { ...updated, status: 'cancelled' })
      setInv(updated)
      toast.success('发票已取消')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  if (!inv) {
    return (
      <div className="text-center py-20 text-gray-400">
        发票不存在或已删除
        <div className="mt-4">
          <Button variant="outline" onClick={() => router.push(`${prefix}/classic/operator/invoices`)}>
            返回列表
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/invoices`)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← 返回发票列表
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{inv.name}</h1>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_COLOR[inv.status]}`}>
            {STATUS_LABEL[inv.status]}
          </span>
        </div>
        <div className="flex gap-2">
          <Link
            href={`${prefix}/classic/operator/invoices/${inv.id}/print`}
            target="_blank"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            ↓ 下载 PDF
          </Link>
          {inv.status === 'draft' && (
            <>
              <Button variant="outline" onClick={handleCancel} className="text-red-600 border-red-200">
                取消发票
              </Button>
              <Button
                onClick={handlePost}
                style={{ background: PURPLE, borderColor: PURPLE }}
                className="text-white hover:opacity-90"
              >
                确认发票
              </Button>
            </>
          )}
          {inv.status === 'posted' && (
            <Button
              onClick={handlePay}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="text-white hover:opacity-90"
            >
              标记已收款
            </Button>
          )}
        </div>
      </div>

      {/* 客户信息 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">客户</p>
            <p className="mt-1 font-semibold text-gray-900">{inv.customerName}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">结款方式</p>
            <p className="mt-1 font-medium text-gray-800">
              {{ cash: '现付', weekly: '周结', monthly: '月结' }[inv.paymentTerms]}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">创建时间</p>
            <p className="mt-1 text-gray-700">{new Date(inv.createdAt).toLocaleString('en-GB')}</p>
          </div>
          {inv.postedAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">确认时间</p>
              <p className="mt-1 text-gray-700">{new Date(inv.postedAt).toLocaleString('en-GB')}</p>
            </div>
          )}
          {inv.paidAt && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">付款时间</p>
              <p className="mt-1 text-green-700 font-medium">{new Date(inv.paidAt).toLocaleString('en-GB')}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">关联订单</p>
            <p className="mt-1 text-gray-600 text-sm">{inv.saleOrderIds.length} 个订单</p>
          </div>
        </div>
      </div>

      {/* 发票明细 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-gray-200" style={{ background: '#f3eff5' }}>
          <h2 className="font-semibold text-gray-700">发票明细</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100">
            <tr className="text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2 font-medium">商品</th>
              <th className="text-center px-4 py-2 font-medium">数量</th>
              <th className="text-right px-4 py-2 font-medium">单价（含税）</th>
              <th className="text-center px-4 py-2 font-medium">税率</th>
              <th className="text-right px-4 py-2 font-medium">税前小计</th>
              <th className="text-right px-4 py-2 font-medium">税额</th>
              <th className="text-right px-4 py-2 font-medium">含税小计</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {inv.lines.map((line, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-800">{line.productName}</p>
                  <p className="text-xs text-gray-400">{line.spec}</p>
                </td>
                <td className="px-4 py-3 text-center">{line.qty}</td>
                <td className="px-4 py-3 text-right">€{line.unitPrice.toFixed(2)}</td>
                <td className="px-4 py-3 text-center text-gray-500">{(line.taxRate * 100).toFixed(1)}%</td>
                <td className="px-4 py-3 text-right">€{line.subtotalExTax.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-gray-500">€{line.taxAmount.toFixed(2)}</td>
                <td className="px-4 py-3 text-right font-medium">€{line.subtotalIncTax.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 汇总 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>税前小计</span>
            <span>€{inv.subtotalExTax.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>VAT 合计</span>
            <span>€{inv.totalTax.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-200 pt-2 mt-2">
            <span>含税总额</span>
            <span>€{inv.totalIncTax.toFixed(2)}</span>
          </div>
          {inv.amountPaid > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>已付款</span>
              <span>€{inv.amountPaid.toFixed(2)}</span>
            </div>
          )}
          <div className={`flex justify-between text-base font-bold ${inv.amountDue > 0 ? 'text-orange-600' : 'text-green-600'}`}>
            <span>待收款</span>
            <span>€{inv.amountDue.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Demo 提示 */}
      <div className="mt-4 p-3 rounded-lg text-xs border bg-purple-50 border-purple-100 text-purple-700">
        <strong>Demo 演示：</strong>草稿 → 点击「确认发票」→ 点击「标记已收款」，模拟 Odoo 发票完整生命周期。
      </div>
      <ActionLogPanel resource="invoice" resourceId={String(params.id)} />
    </div>
  )
}
