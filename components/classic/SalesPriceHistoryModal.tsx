'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { History as HistoryIcon } from 'lucide-react'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'

interface SalesPriceHistoryEntry {
  date: string
  orderId: string
  orderNumber: string
  quantity: number
  unitPrice: number
  uom: string | null
}

interface SalesPriceHistoryResponse {
  history: SalesPriceHistoryEntry[]
}

/**
 * 订单/报价单行"历史价格"图标 + 弹窗：查看该商品卖给该客户的最近成交价，
 * 可选中一条替换本次单价（onSelectPrice 传入时才显示选择按钮，即仅编辑态可用）。
 */
export function SalesPriceHistoryButton({
  customerId,
  productId,
  productName,
  onSelectPrice,
}: {
  customerId: string | null | undefined
  productId: string
  productName: string
  onSelectPrice?: (price: number) => void
}) {
  const [open, setOpen] = useState(false)
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  if (!customerId || !productId) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-1 text-gray-400 hover:text-gray-600 align-middle"
        title={isEn ? 'View historical prices' : '查看历史价格'}
      >
        <HistoryIcon size={13} />
      </button>
      {open && (
        <SalesPriceHistoryModal
          customerId={customerId}
          productId={productId}
          productName={productName}
          onClose={() => setOpen(false)}
          onSelectPrice={onSelectPrice ? (price) => { onSelectPrice(price); setOpen(false) } : undefined}
        />
      )}
    </>
  )
}

function SalesPriceHistoryModal({
  customerId,
  productId,
  productName,
  onClose,
  onSelectPrice,
}: {
  customerId: string
  productId: string
  productName: string
  onClose: () => void
  onSelectPrice?: (price: number) => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState<SalesPriceHistoryEntry[]>([])

  async function load() {
    setLoading(true)
    try {
      const res = await apiGet<SalesPriceHistoryResponse>(
        `/api/orders/sales-price-history?customerId=${encodeURIComponent(customerId)}&productId=${encodeURIComponent(productId)}&limit=20`
      )
      setHistory(res.history)
    } catch {
      setHistory([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [customerId, productId])

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-xl p-5 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">
            {isEn ? 'History price of ' : '历史价格：'}{productName}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'Loading…' : '加载中…'}</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'No sales history yet' : '暂无历史成交记录'}</p>
        ) : (
          <div className="max-h-96 overflow-y-auto border border-gray-100 rounded-lg">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left font-medium py-2 px-2">{isEn ? 'Date' : '日期'}</th>
                  <th className="text-left font-medium py-2 px-2">{isEn ? 'Order No.' : '单号'}</th>
                  <th className="text-right font-medium py-2 px-2">{isEn ? 'Quantity' : '数量'}</th>
                  <th className="text-left font-medium py-2 px-2">{isEn ? 'Unit' : '单位'}</th>
                  <th className="text-right font-medium py-2 px-2">{isEn ? 'Unit Price' : '单价'}</th>
                  {onSelectPrice && <th className="py-2 px-2"></th>}
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.orderId + i} className="border-b border-gray-50 last:border-0">
                    <td className="py-1.5 px-2 text-gray-500">
                      {new Date(h.date).toLocaleString('en-CA', { hour12: false })}
                    </td>
                    <td className="py-1.5 px-2 text-gray-500">{h.orderNumber}</td>
                    <td className="py-1.5 px-2 text-right">{h.quantity.toFixed(3)}</td>
                    <td className="py-1.5 px-2 text-gray-500">{h.uom ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-medium">{h.unitPrice.toFixed(2)}</td>
                    {onSelectPrice && (
                      <td className="py-1.5 px-2 text-right">
                        <button
                          onClick={() => onSelectPrice(h.unitPrice)}
                          className="text-xs px-2 py-0.5 border rounded hover:bg-gray-50"
                          style={{ borderColor: PURPLE, color: PURPLE }}
                        >
                          {isEn ? 'Select Price' : '选用此价'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
