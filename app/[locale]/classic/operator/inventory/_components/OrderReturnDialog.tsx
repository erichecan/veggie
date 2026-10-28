'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiPut } from '@/lib/api'
import type { OrderReturn } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SCRAP_REASON_LABEL, SCRAP_REASON_LABEL_EN } from '@/lib/scrap-reasons'
import { TRIP_STATUS_COLORS, TRIP_STATUS_LABELS_ZH, TRIP_STATUS_LABELS_EN, type ReturnStatus } from './TripReturnReviewDialog'

/**
 * 退货/报废整合 M1+M3：日销售中心手动登记（OrderReturn 表）来源的核实/审核弹窗。
 * 跟 Trip/ReturnItem 版（TripReturnReviewDialog）状态机/disposition 规则完全一致
 * （共用 lib/returns-engine.ts），但 OrderReturn 没有退款字段，审核只需选 disposition，
 * 所以不照搬那个弹窗的退款%/换货单号/订单档案等 UI——字段本来就没有，硬做等于造假 UI。
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
  const [disposition, setDisposition] = useState<'SELLABLE' | 'SCRAP'>('SELLABLE')
  const [scrapReason, setScrapReason] = useState<'CUSTOMER_RETURN_EXPIRED' | 'CUSTOMER_RETURN_DAMAGED' | 'OTHER'>('CUSTOMER_RETURN_DAMAGED')
  const [saving, setSaving] = useState(false)

  const status = item.status as ReturnStatus

  async function verify(action: 'verify' | 'reject') {
    if (action === 'reject' && !note.trim()) {
      toast.error(isEn ? 'A reason is required to reject' : '核实不通过必须填写原因')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/order-returns/${item.id}/warehouse-verify`, { action, note: note.trim() || undefined })
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
      await apiPut(`/api/order-returns/${item.id}/review`, {
        action,
        disposition: action === 'approve' ? disposition : undefined,
        scrapReason: action === 'approve' && disposition === 'SCRAP' ? scrapReason : undefined,
        note: note.trim() || undefined,
      })
      toast.success(action === 'approve'
        ? (isEn ? 'Return approved' : '已批准')
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
            <span className="ml-2 text-xs font-normal text-emerald-600">{isEn ? '📝 Manually registered' : '📝 手动登记'}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-900">{item.productName}</span>
            <span className="text-orange-700 font-semibold">×{item.quantity}</span>
          </div>
          <div className="text-xs text-gray-500">{isEn ? 'Order' : '订单'} {item.order?.code ?? item.orderId}</div>
          {item.reason && <div className="text-xs text-orange-600">{isEn ? 'Reason: ' : '原因：'}{item.reason}</div>}
          {item.actionType === 'exchange' && (
            <div className="text-xs text-blue-500">
              {isEn ? 'Exchange order: ' : '换货新单号：'}{item.exchangeOrderId || (isEn ? 'not provided' : '未填写')}
            </div>
          )}
          <div>
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${TRIP_STATUS_COLORS[status]}`}>
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {status === 'WAREHOUSE_PENDING' && readOnly && (
          <p className="text-xs text-gray-400">{isEn ? 'View only — your role cannot perform the warehouse check' : '仅查看——你的角色没有仓库核实权限'}</p>
        )}
        {status === 'WAREHOUSE_PENDING' && !readOnly && (
          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">{isEn ? 'Warehouse Note (required to reject)' : '核实备注（拒绝时必填）'}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder={isEn ? 'Describe the physical check result…' : '说明实物核对结果…'}
              className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
            />
          </div>
        )}

        {status === 'PENDING_REVIEW' && readOnly && (
          <p className="text-xs text-gray-400">{isEn ? 'View only — your role cannot review this' : '仅查看——你的角色没有审核权限'}</p>
        )}

        {status === 'PENDING_REVIEW' && !readOnly && (
          <div className="space-y-2">
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

        {status === 'APPROVED' && item.disposition && (
          <p className="text-xs text-gray-500">
            {isEn ? 'Disposition: ' : '货物去向：'}{item.disposition === 'SELLABLE' ? (isEn ? 'Sellable (restocked)' : '可再售（已回补库存）') : (isEn ? 'Scrap (recorded as loss)' : '报废（已计入损耗）')}
          </p>
        )}
        {status === 'REJECTED' && item.warehouseNote && (
          <p className="text-xs text-red-500">{isEn ? 'Reject reason: ' : '拒绝原因：'}{item.warehouseNote}</p>
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
