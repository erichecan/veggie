'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiDelete, ApiError } from '@/lib/api'

/**
 * 订单调整行（折扣/配送费/差价修正）—— 不对应任何库存商品的金额调整。
 * 取代此前"新建虚构商品塞进订单行"的将就做法，见 lib/order-adjustments.ts。
 * 报价单/销售单详情页共用；orderId 变化时自动重新拉取。
 */

type AdjustmentType = 'DISCOUNT' | 'DELIVERY_FEE' | 'PRICE_CORRECTION' | 'OTHER'

interface OrderAdjustment {
  id: string
  type: AdjustmentType
  label: string
  amount: number
  note: string | null
}

const TYPES: readonly AdjustmentType[] = ['DISCOUNT', 'DELIVERY_FEE', 'PRICE_CORRECTION', 'OTHER']
const TYPE_LABEL_ZH: Record<AdjustmentType, string> = {
  DISCOUNT: '折扣', DELIVERY_FEE: '配送费', PRICE_CORRECTION: '差价调整', OTHER: '其他',
}
const TYPE_LABEL_EN: Record<AdjustmentType, string> = {
  DISCOUNT: 'Discount', DELIVERY_FEE: 'Delivery Fee', PRICE_CORRECTION: 'Price Correction', OTHER: 'Other',
}

export default function OrderAdjustmentsPanel({
  orderId,
  editable,
  isEn,
  onTotalChange,
}: {
  orderId: string
  editable: boolean
  isEn: boolean
  /** 调整合计变化时回调，供父组件把它并进"应付总额"展示 */
  onTotalChange?: (total: number) => void
}) {
  const [items, setItems] = useState<OrderAdjustment[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [type, setType] = useState<AdjustmentType>('DISCOUNT')
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')

  const TYPE_LABEL = isEn ? TYPE_LABEL_EN : TYPE_LABEL_ZH

  const load = useCallback(async () => {
    try {
      const data = await apiGet<OrderAdjustment[]>(`/api/orders/${orderId}/adjustments`)
      setItems(data)
    } catch {
      // 调整行是详情页的增值信息，读取失败不阻塞整页渲染，静默留空即可
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => { load() }, [load])

  const total = items.reduce((s, a) => s + Number(a.amount), 0)
  // total 是唯一有意义的依赖——onTotalChange 允许父组件每次渲染传新的闭包
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onTotalChange?.(total) }, [total])

  async function handleAdd() {
    const amountNum = Number(amount)
    if (!label.trim()) {
      toast.error(isEn ? 'Please enter a label' : '请填写调整说明')
      return
    }
    if (!Number.isFinite(amountNum) || amountNum === 0) {
      toast.error(isEn ? 'Amount must be a non-zero number' : '金额必须是非零数字')
      return
    }
    setAdding(true)
    try {
      await apiPost(`/api/orders/${orderId}/adjustments`, { type, label: label.trim(), amount: amountNum })
      setLabel('')
      setAmount('')
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (isEn ? 'Failed to add' : '添加失败'))
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(adjustmentId: string) {
    try {
      await apiDelete(`/api/orders/${orderId}/adjustments/${adjustmentId}`)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (isEn ? 'Failed to remove' : '删除失败'))
    }
  }

  if (loading || (items.length === 0 && !editable)) return null

  return (
    <div className="border-t border-gray-200 px-6 py-3 bg-gray-50 text-sm">
      <div className="text-xs font-medium text-gray-500 mb-2">
        {isEn ? 'Adjustments (discount / delivery fee / price correction)' : '调整行（折扣 / 配送费 / 差价调整）'}
      </div>
      {items.length > 0 && (
        <div className="space-y-1 mb-2">
          {items.map(a => (
            <div key={a.id} className="flex items-center justify-between text-gray-700">
              <span>{TYPE_LABEL[a.type]} · {a.label}</span>
              <span className="flex items-center gap-2">
                <span className={Number(a.amount) < 0 ? 'text-red-600' : 'text-gray-800'}>
                  € {Number(a.amount).toFixed(2)}
                </span>
                {editable && (
                  <button
                    onClick={() => handleDelete(a.id)}
                    className="text-gray-400 hover:text-red-600 text-xs"
                  >
                    {isEn ? 'Remove' : '删除'}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {editable && (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={type}
            onChange={e => setType(e.target.value as AdjustmentType)}
            className="border border-gray-300 rounded px-2 py-1 text-xs"
          >
            {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={isEn ? 'Label' : '说明'}
            className="border border-gray-300 rounded px-2 py-1 text-xs w-36"
          />
          <input
            value={amount}
            onChange={e => setAmount(e.target.value)}
            type="number"
            step="0.01"
            placeholder={isEn ? 'Amount (+/-)' : '金额（可负）'}
            className="border border-gray-300 rounded px-2 py-1 text-xs w-28"
          />
          <button
            onClick={handleAdd}
            disabled={adding}
            className="px-3 py-1 rounded text-xs text-white disabled:opacity-40"
            style={{ background: '#875A7B' }}
          >
            {adding ? (isEn ? 'Adding…' : '添加中…') : (isEn ? '+ Add' : '+ 添加')}
          </button>
        </div>
      )}
    </div>
  )
}
