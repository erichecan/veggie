'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { OrderReturn } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import { SCRAP_REASON_LABEL, SCRAP_REASON_LABEL_EN } from '@/lib/scrap-reasons'
import { TRIP_STATUS_COLORS, TRIP_STATUS_LABELS_ZH, TRIP_STATUS_LABELS_EN, type ReturnStatus } from './TripReturnReviewDialog'

/** Shared warehouse and Sales review dialog for canonical driver/manual returns.
 * Warehouse owns receipt/quality/disposition; Sales owns credited quantity and decision.
 * Approval queues Finance; this dialog never posts stock or financial effects.
 */

export interface OrderReturnDialogProps {
  item: OrderReturn
  onClose: () => void
  onSaved: () => void
  readOnly?: boolean
}

export function OrderReturnDialog({ item, onClose, onSaved, readOnly }: OrderReturnDialogProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABELS = isEn ? TRIP_STATUS_LABELS_EN : TRIP_STATUS_LABELS_ZH
  const scrapLabels = isEn ? SCRAP_REASON_LABEL_EN : SCRAP_REASON_LABEL

  const [note, setNote] = useState('')
  const [disposition, setDisposition] = useState<'SELLABLE' | 'SCRAP'>(item.disposition ?? 'SELLABLE')
  const [scrapReason, setScrapReason] = useState<'CUSTOMER_RETURN_EXPIRED' | 'CUSTOMER_RETURN_DAMAGED' | 'OTHER'>('CUSTOMER_RETURN_DAMAGED')
  const [approvedQuantity, setApprovedQuantity] = useState(String(item.approvedQuantity ?? item.warehouseAcceptedQuantity ?? item.quantity))
  const [actualStockQuantity, setActualStockQuantity] = useState(String(item.actualReturnedStockQuantity ?? ''))
  const [saving, setSaving] = useState(false)
  const [acceptedQuantity, setAcceptedQuantity] = useState(String(item.warehouseAcceptedQuantity ?? item.quantity))
  const [exchangeOrderId, setExchangeOrderId] = useState(item.exchangeOrderId ?? '')
  const [products, setProducts] = useState<Array<{ id: string; name: string; internalRef?: string | null; listPrice?: number; price?: number; standardPrice?: number }>>([])
  const [actualProduct, setActualProduct] = useState<{ id: string; name: string; internalRef?: string | null } | null>(item.actualReturnedProductId ? { id: item.actualReturnedProductId, name: item.actualReturnedProductName ?? '' } : null)

  useEffect(() => { apiGet<typeof products>('/api/products?status=ACTIVE&sellable=1&slim=1').then(setProducts).catch(() => {}) }, [])

  const status = item.status as ReturnStatus

  async function verify(action: 'verify' | 'reject') {
    if (!note.trim()) {
      toast.error(action === 'verify'
        ? (isEn
          ? 'Enter the quality and physical check results in “Quality / warehouse note” before verifying.'
          : '请先填写“质量说明”，记录实物和质量检查结果，再核实通过。')
        : (isEn
          ? 'Enter the rejection reason in “Quality / warehouse note” before rejecting.'
          : '请先在“质量说明”中填写核实不通过的原因。'))
      return
    }
    if (action === 'verify' && !['SELLABLE', 'SCRAP'].includes(disposition)) {
      toast.error(isEn
        ? 'Choose a disposition: Sellable (Restock) or Scrap (Record as Loss).'
        : '请先选择货物去向：“可再售（回补库存）”或“报废（计入损耗）”。')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/order-returns/${item.id}/warehouse-verify`, {
        action, note: note.trim() || undefined, disposition, scrapReason, actualReturnedStockQuantity: Number(actualStockQuantity),
        acceptedQuantity: Number(acceptedQuantity), actualReturnedProductId: actualProduct?.id,
        actualReturnedProductName: actualProduct?.name,
      })
      toast.success(action === 'verify'
        ? (isEn ? 'Verified, sent for review' : '已核实通过，转入审核')
        : (isEn ? 'Rejected' : '已标记核实不通过'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '操作失败'))
    } finally {
      setSaving(false)
    }
  }

  async function review(action: 'approve' | 'reject') {
    setSaving(true)
    try {
      const result = await apiPut<{ creditNoteRequests?: Array<{ name: string }> }>(`/api/order-returns/${item.id}/review`, {
        action, approvedQuantity: Number(approvedQuantity),
        disposition: action === 'approve' ? disposition : undefined,
        scrapReason: action === 'approve' && disposition === 'SCRAP' ? scrapReason : undefined,
        exchangeOrderId: action === 'approve' && item.actionType === 'exchange' ? exchangeOrderId.trim() : undefined,
        note: note.trim() || undefined,
      })
      toast.success(action === 'approve'
        ? (result.creditNoteRequests?.length
          ? (isEn ? `Approved · sent to Finance ${result.creditNoteRequests.map(cn => cn.name).join(', ')}` : `已批准退货，申请 ${result.creditNoteRequests.map(cn => cn.name).join(', ')} 已提交会计审核`)
          : (isEn ? 'Return approved · no credit note is created for un-invoiced delivery' : '已提交会计确认'))
        : (isEn ? 'Return rejected' : '已拒绝'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Review failed' : '操作失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent style={{ maxWidth: 520 }}>
        <DialogHeader>
          <DialogTitle style={{ color: '#875A7B' }}>
            {isEn ? 'Return/Exchange' : '退换货'} — {item.order?.restaurantName ?? '—'}
            <span className="ml-2 text-xs font-normal text-emerald-600">{item.sourceTripId ? (isEn ? '🚚 Driver report' : '🚚 司机上报') : (isEn ? '📝 Warehouse / manual' : '📝 仓库 / 手动登记')}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-900">{item.productName}</span>
            <span className="text-orange-700 font-semibold">×{item.quantity}</span>
          </div>
          {item.actualReturnedProductName && <div className="text-xs font-medium text-blue-700">{isEn ? 'Actual returned item: ' : '实际退回商品：'}{item.actualReturnedProductName}</div>}
          {status === 'WAREHOUSE_PENDING' && !readOnly && <div className="grid gap-2 border-t border-orange-200 pt-2 sm:grid-cols-2">
            <label className="text-xs text-gray-600">{isEn ? 'Received quantity' : '仓库实收数量'}<input type="number" min="0.001" max={Number(item.quantity)} step="0.001" value={acceptedQuantity} onChange={e => setAcceptedQuantity(e.target.value)} className="mt-1 w-full rounded border px-2 py-1.5 text-sm" /></label>
            <label className="text-xs text-gray-600">{isEn ? 'Actual product received (if different)' : '实际收到商品（送错商品时选择）'}<ProductSearchInput value={actualProduct?.name ?? item.actualReturnedProductName ?? ''} onChange={value => setActualProduct(current => current ? { ...current, name: value, id: '' } : { id: '', name: value })} onSelect={product => setActualProduct(product)} products={products} placeholder={isEn ? 'Search actual product…' : '搜索实际商品…'} inputClassName="mt-1 w-full rounded border px-2 py-1.5 text-sm" portalDropdown /></label>
          </div>}
          <div className="text-xs text-gray-500">{isEn ? 'Order' : '订单'} {item.order?.code ?? item.orderId}</div>
          {item.reason && <div className="text-xs text-orange-600">{isEn ? 'Reason: ' : '原因：'}{item.reason}</div>}
          {item.actionType === 'exchange' && (
            <div className="text-xs text-blue-500">
              {isEn ? 'Exchange order: ' : '换货新单号：'}{item.exchangeOrderId || (isEn ? 'not provided' : '未填写')}
            </div>
          )}
          <div>
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${TRIP_STATUS_COLORS[status]}`}>
              {status === 'APPROVED' && item.workflowVersion === 2 ? (isEn ? 'Awaiting Finance confirmation' : '待会计确认') : STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {status === 'WAREHOUSE_PENDING' && readOnly && (
          <p className="text-xs text-gray-400">{isEn ? 'View only — your role cannot perform the warehouse check' : '仅查看——你的角色没有仓库核实权限'}</p>
        )}
        {status === 'WAREHOUSE_PENDING' && !readOnly && (
          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">{isEn ? 'Quality / warehouse note (required for verification)' : '质量说明（核实必填）'}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              required
              aria-required="true"
              rows={2}
              placeholder={isEn ? 'For example: received 1, item matches the return record, packaging intact.' : '例如：实收 1 件，商品与登记一致，外包装完好。'}
              className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
            />
            <p className="text-[11px] text-gray-400">{isEn ? 'Record the received item, quantity, and its condition.' : '请记录实收商品、数量及外观/质量情况。'}</p>
          </div>
        )}

        {status === 'PENDING_REVIEW' && readOnly && (
          <p className="text-xs text-gray-400">{isEn ? 'View only — your role cannot review this' : '仅查看——你的角色没有审核权限'}</p>
        )}

        {status === 'WAREHOUSE_PENDING' && !readOnly && (
          <div className="space-y-2">
            {item.actionType === 'exchange' && (
              <label className="block text-xs text-gray-600">
                {isEn ? 'Replacement order number (create the new order separately)' : '补送新订单号（请先单独创建补送订单）'}
                <input value={exchangeOrderId} onChange={e => setExchangeOrderId(e.target.value)} className="mt-1 w-full rounded border px-2 py-1.5 text-sm" placeholder={isEn ? 'e.g. D-261117-001' : '例如：D-261117-001'} />
              </label>
            )}
            <p className="text-sm font-medium text-gray-700">{isEn ? 'Disposition' : '货物去向'} <span className="text-red-500">*</span></p>
            <div className="flex gap-2">
              <button
                onClick={() => setDisposition('SELLABLE')}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                  disposition === 'SELLABLE' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-green-300'
                }`}
                style={disposition === 'SELLABLE' ? { background: '#15803d', borderColor: '#15803d' } : {}}
              >
                {isEn ? '✅ Sellable (Restock)' : '✅ 可再售（回补库存）'}
              </button>
              <button
                onClick={() => setDisposition('SCRAP')}
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                  disposition === 'SCRAP' ? 'text-white' : 'border-gray-200 text-gray-600 hover:border-orange-300'
                }`}
                style={disposition === 'SCRAP' ? { background: '#a3690e', borderColor: '#a3690e' } : {}}
              >
                {isEn ? '🗑️ Scrap (Record as Loss)' : '🗑️ 报废（计入损耗）'}
              </button>
            </div>
            {disposition === 'SCRAP' && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">{isEn ? 'Scrap Reason' : '报废原因'}</label>
                <select
                  value={scrapReason}
                  onChange={e => setScrapReason(e.target.value as typeof scrapReason)}
                  className="border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-purple-400"
                >
                  <option value="CUSTOMER_RETURN_DAMAGED">{scrapLabels.CUSTOMER_RETURN_DAMAGED}</option>
                  <option value="CUSTOMER_RETURN_EXPIRED">{scrapLabels.CUSTOMER_RETURN_EXPIRED}</option>
                  <option value="OTHER">{scrapLabels.OTHER}</option>
                </select>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs text-gray-500 font-medium">{isEn ? 'Review Note (optional)' : '审核备注（可选）'}</label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                placeholder={isEn ? 'Describe review outcome…' : '说明审核结果…'}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
              />
            </div>
          </div>
        )}

        {status === 'PENDING_REVIEW' && !readOnly && <div className="space-y-2">
          <p className="text-sm">{isEn ? 'Warehouse disposition: ' : '仓库验收去向：'}{item.disposition === 'SCRAP' ? (isEn ? 'Scrap' : '报废') : (isEn ? 'Sellable' : '可再售')}</p>
          <label className="block text-sm">{isEn ? 'Quantity approved for credit (less than received = partial approval)' : '批准退货数量（小于实收即部分批准）'}<input type="number" min="0.001" max={Number(item.warehouseAcceptedQuantity ?? item.quantity)} step="0.001" value={approvedQuantity} onChange={e => setApprovedQuantity(e.target.value)} className="mt-1 w-full rounded border px-2 py-2" /></label>
          <textarea aria-label={isEn ? 'Sales review note' : '销售审核备注'} value={note} onChange={e => setNote(e.target.value)} placeholder={isEn ? 'Reason required for partial approval or rejection' : '部分批准或拒绝时必须填写原因'} className="w-full rounded border p-2" />
          {item.actionType === 'exchange' && <input aria-label={isEn ? 'Replacement order' : '补送订单号'} value={exchangeOrderId} onChange={e => setExchangeOrderId(e.target.value)} className="w-full rounded border p-2" />}
          <p className="text-xs text-amber-700">{isEn ? 'Approval submits a Finance request. Stock and delivered quantity remain unchanged until Finance confirms.' : '批准后提交会计确认，此时不调整库存或实送量。'}</p>
        </div>}
        {item.sourceTrip && <p className="text-sm text-gray-600">{isEn ? 'Driver / vehicle: ' : '司机 / 车牌：'}{item.sourceTrip.driverName || '—'} / {item.sourceTrip.vehiclePlate || '—'} · {new Date(item.sourceTrip.createdAt).toLocaleDateString('en-GB')}</p>}
        {item.photo && <img src={item.photo} alt={isEn ? 'Return photo' : '退货照片'} className="h-24 w-24 rounded object-cover" />}
        {status === 'WAREHOUSE_PENDING' && !readOnly && actualProduct?.id && actualProduct.id !== item.productId && <label className="text-sm">{isEn ? 'Actual item quantity in BASE STOCK unit (not the original product unit)' : '实际商品的基础库存单位数量（非原商品单位）'}<input type="number" min="0.001" step="0.001" value={actualStockQuantity} onChange={e => setActualStockQuantity(e.target.value)} className="w-full rounded border p-2" /></label>}
        {status === 'APPROVED' && item.disposition && (
          <p className="text-xs text-gray-500">
            {isEn ? 'Disposition: ' : '货物去向：'}{item.disposition === 'SELLABLE' ? (isEn ? 'Sellable — awaiting Finance' : '可再售，待会计确认') : (isEn ? 'Scrap — awaiting Finance' : '报废，待会计确认')}
          </p>
        )}
        {/* 仓库备注/销售备注彼此独立展示，不互相覆盖——仓库核实不通过写 warehouseNote，
            销售审核（批准/拒绝）写 salesNote，一条记录最多命中其中一个阶段的拒绝备注 */}
        {item.warehouseNote && (
          <p className="text-xs text-gray-500">{isEn ? 'Warehouse note: ' : '仓库备注：'}{item.warehouseNote}</p>
        )}
        {item.salesNote && (
          <p className={`text-xs ${status === 'REJECTED' ? 'text-red-500' : 'text-gray-500'}`}>
            {isEn ? 'Sales note: ' : '销售备注：'}{item.salesNote}
          </p>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {isEn ? 'Cancel' : '取消'}
          </Button>
          {status === 'WAREHOUSE_PENDING' && !readOnly && (
            <>
              <Button
                onClick={() => verify('reject')}
                disabled={saving}
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50"
              >
                {isEn ? 'Reject' : '核实不通过'}
              </Button>
              <Button
                onClick={() => verify('verify')}
                disabled={saving}
                style={{ background: '#875A7B', borderColor: '#875A7B' }}
                className="text-white hover:opacity-90"
              >
                {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Verify' : '核实通过')}
              </Button>
            </>
          )}
          {status === 'PENDING_REVIEW' && !readOnly && (
            <>
              <Button
                onClick={() => review('reject')}
                disabled={saving}
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50"
              >
                {isEn ? 'Reject' : '拒绝'}
              </Button>
              <Button
                onClick={() => review('approve')}
                disabled={saving}
                style={{ background: '#875A7B', borderColor: '#875A7B' }}
                className="text-white hover:opacity-90"
              >
                {saving
                  ? (isEn ? 'Saving…' : '保存中…')
                  : (isEn
                      ? `Approve — ${disposition === 'SELLABLE' ? 'Resellable' : 'Scrap'}`
                      : `批准（${disposition === 'SELLABLE' ? '可再售' : '报废'}）`)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
