'use client'
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

export interface HistoryPOLine {
  productId: string
  productName: string
  uomId: string | null
  orderedQty: number
  unitCost: number
  taxRate: number
}

export interface HistoryPO {
  id: string
  name: string
  orderDate: string
  status: string
  totalIncTax: number
  lines: HistoryPOLine[]
}

/** 新建采购单页"从历史单复制"：按供应商列出历史采购单，选中后把行项目原样带入当前草稿 */
export default function CopyFromHistoryModal({
  supplierId,
  isEn,
  onClose,
  onPick,
}: {
  supplierId: string
  isEn: boolean
  onClose: () => void
  onPick: (po: HistoryPO) => void
}) {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<HistoryPO[]>([])

  useEffect(() => {
    setLoading(true)
    apiGet<HistoryPO[]>(`/api/purchase-orders?supplierId=${encodeURIComponent(supplierId)}&limit=20`)
      .then(setOrders)
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [supplierId])

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[80vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Copy from Historical Order' : '从历史单复制'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'Loading…' : '加载中…'}</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            {isEn ? 'No historical purchase orders for this supplier yet' : '该供应商暂无历史采购单'}
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left font-normal py-1">{isEn ? 'Order' : '单号'}</th>
                <th className="text-left font-normal py-1">{isEn ? 'Date' : '日期'}</th>
                <th className="text-left font-normal py-1">{isEn ? 'Status' : '状态'}</th>
                <th className="text-right font-normal py-1">{isEn ? 'Total' : '金额'}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {orders.map(po => (
                <tr key={po.id} className="border-t border-gray-100">
                  <td className="py-1.5 font-medium" style={{ color: PURPLE }}>{po.name}</td>
                  <td className="py-1.5 text-gray-500">{formatDateOnly(po.orderDate)}</td>
                  <td className="py-1.5 text-gray-500">{po.status}</td>
                  <td className="py-1.5 text-right">{po.totalIncTax.toFixed(2)}</td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => { onPick(po); onClose() }}
                      className="text-xs hover:underline"
                      style={{ color: PURPLE }}
                    >
                      {isEn ? 'Copy' : '复制'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
