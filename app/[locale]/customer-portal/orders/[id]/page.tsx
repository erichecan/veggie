'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import { toast } from 'sonner'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  PENDING:        { label: '待确认', color: '#b45309', bg: '#fef3c7' },
  CONFIRMED:      { label: '已确认', color: '#1d4ed8', bg: '#dbeafe' },
  WAVE_ASSIGNED:  { label: '拣货中', color: '#6d28d9', bg: '#ede9fe' },
  IN_DELIVERY:    { label: '配送中', color: '#0891b2', bg: '#cffafe' },
  COMPLETED:      { label: '已完成', color: '#15803d', bg: '#dcfce7' },
  LOCKED:         { label: '已锁定', color: '#374151', bg: '#e5e7eb' },
  CANCELLED:      { label: '已取消', color: '#dc2626', bg: '#fee2e2' },
}

interface OrderLine {
  id: string
  productName: string
  spec: string | null
  uomName: string | null
  unitPrice: number
  taxRate: number
  orderedQty: number
  deliveredQty: number
  subtotal: number
  sequence: number
}

interface OrderDetail {
  id: string
  code: string
  status: string
  totalAmount: number
  paymentMethod: string
  deliveryDate: string | null
  quotationDate: string | null
  createdAt: string
  internalNote: string | null
  driverSlot: { driverName: string; slotLabel: string } | null
  lines: OrderLine[]
}

export default function CustomerOrderDetailPage() {
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const params = useParams()
  const id = params.id as string
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    apiGet<OrderDetail>(`/api/customer-portal/orders/${id}`)
      .then(setOrder)
      .catch(() => toast.error('加载订单详情失败'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="text-center py-20 text-gray-400">加载中...</div>
  if (!order) return <div className="text-center py-20 text-gray-400">订单不存在</div>

  const st = STATUS_MAP[order.status] || { label: order.status, color: '#666', bg: '#eee' }

  // 行上的 taxRate 存的是百分数（13.5）。order.totalAmount 是**税前**口径（系统 SSOT），
  // 此前本页只显示这一个数且不加标注，客户无从知道账单上还要加 VAT。
  // 注意：这是普通常量不是 hook，放在提前 return 之后没有 hooks 顺序问题。
  const orderTax = (order.lines ?? []).reduce(
    (s, l) => s + Number(l.subtotal) * (Number(l.taxRate ?? 0) / 100), 0)

  return (
    <div className="space-y-5">
      <Link href={`${prefix}/customer-portal/orders`}
        className="inline-flex items-center gap-1 text-sm hover:underline" style={{ color: PURPLE }}>
        ← 返回订单列表
      </Link>

      <div className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">{order.code || order.id.slice(0, 8)}</h1>
              <span className="text-sm px-3 py-1 rounded-full font-medium"
                style={{ background: st.bg, color: st.color }}>
                {st.label}
              </span>
            </div>
            <div className="text-sm text-gray-500 mt-2 space-y-1">
              <p>下单时间: {formatDateOnly(order.createdAt)}</p>
              {order.deliveryDate && <p>配送日期: {formatDateOnly(order.deliveryDate)}</p>}
              {order.quotationDate && <p>报价日期: {formatDateOnly(order.quotationDate)}</p>}
              <p>付款方式: {order.paymentMethod === 'CASH' ? '现金' : '在线支付'}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-400">{orderTax > 0 ? '含税应付' : '订单金额'}</p>
            <p className="text-2xl font-bold" style={{ color: PURPLE }}>
              €{(Number(order.totalAmount) + orderTax).toFixed(2)}
            </p>
            {orderTax > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">
                不含税 €{Number(order.totalAmount).toFixed(2)} + 税 €{orderTax.toFixed(2)}
              </p>
            )}
          </div>
        </div>

        {order.driverSlot && (
          <div className="bg-blue-50 rounded-lg px-4 py-3 text-sm">
            <span className="font-medium text-blue-700">配送信息: </span>
            <span className="text-blue-600">{order.driverSlot.driverName} · {order.driverSlot.slotLabel}</span>
          </div>
        )}

        {order.internalNote && (
          <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm">
            <span className="font-medium text-gray-600">备注: </span>
            <span className="text-gray-500">{order.internalNote}</span>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-5 py-3 border-b">
          <h2 className="font-bold text-sm" style={{ color: PURPLE }}>商品明细</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-5 py-2.5">商品</th>
              <th className="text-right px-3 py-2.5">单价</th>
              <th className="text-right px-3 py-2.5">下单数量</th>
              <th className="text-right px-3 py-2.5">实送数量</th>
              <th className="text-right px-5 py-2.5">小计</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {order.lines
              .sort((a, b) => a.sequence - b.sequence)
              .map(line => (
                <tr key={line.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <p className="font-medium">{line.productName}</p>
                    <p className="text-xs text-gray-400">
                      {line.spec && <span>{line.spec} · </span>}
                      {line.uomName || '个'}
                    </p>
                  </td>
                  <td className="text-right px-3 py-3">€{Number(line.unitPrice).toFixed(2)}</td>
                  <td className="text-right px-3 py-3">{Number(line.orderedQty)}</td>
                  <td className="text-right px-3 py-3">
                    {Number(line.deliveredQty) > 0 ? Number(line.deliveredQty) : '-'}
                  </td>
                  <td className="text-right px-5 py-3 font-medium">€{Number(line.subtotal).toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot className="border-t">
            <tr>
              <td colSpan={4} className="text-right px-3 py-2 text-gray-500">合计（不含税）</td>
              <td className="text-right px-5 py-2 text-gray-600">
                €{Number(order.totalAmount).toFixed(2)}
              </td>
            </tr>
            {orderTax > 0 && (
              <>
                <tr>
                  <td colSpan={4} className="text-right px-3 py-2 text-gray-500">税额</td>
                  <td className="text-right px-5 py-2 text-gray-600">€{orderTax.toFixed(2)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="text-right px-3 py-3 font-bold">含税应付</td>
                  <td className="text-right px-5 py-3 font-bold" style={{ color: PURPLE }}>
                    €{(Number(order.totalAmount) + orderTax).toFixed(2)}
                  </td>
                </tr>
              </>
            )}
          </tfoot>
        </table>
      </div>
    </div>
  )
}
