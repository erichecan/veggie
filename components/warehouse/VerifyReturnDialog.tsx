'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiPut } from '@/lib/api'
import type { Trip, ReturnItem as CanonicalReturnItem } from '@/lib/types'
import { DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const PURPLE = '#875A7B'

export interface PendingReturn extends CanonicalReturnItem {
  tripId: string
  tripCreatedAt: string
  driverName: string
  restaurantId: string
  restaurantName: string
}

/**
 * 仓库核实（20260922）：司机上报的退换货先落 WAREHOUSE_PENDING，仓库工作人员
 * 次日核对实物是否真的在车上、与纸质单是否一致，核实通过才转入销售审核队列
 * （`operator/returns`）；核实不通过直接打回，货物核实靠人眼看车，系统只记结果。
 */
export function flattenPending(trips: Trip[]): PendingReturn[] {
  const rows: PendingReturn[] = []
  for (const trip of trips) {
    for (const rest of trip.restaurants ?? []) {
      for (const ret of rest.returns ?? []) {
        if (ret.status !== 'WAREHOUSE_PENDING') continue
        rows.push({
          ...ret,
          tripId: trip.id,
          tripCreatedAt: trip.createdAt,
          driverName: trip.driverName ?? '—',
          restaurantId: rest.restaurantId,
          restaurantName: rest.restaurantName,
        })
      }
    }
  }
  return rows.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())
}

export function VerifyReturnDialog({ item, onClose, onSaved }: { item: PendingReturn; onClose: () => void; onSaved: () => void }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function act(action: 'verify' | 'reject') {
    if (action === 'reject' && !note.trim()) {
      toast.error(isEn ? 'Please explain why the check failed' : '请填写核实不通过的原因')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/trips/${item.tripId}/returns/warehouse-verify`, {
        restaurantId: item.restaurantId,
        productId: item.productId,
        returnId: item.id,
        action,
        note: note.trim() || undefined,
      })
      toast.success(action === 'verify'
        ? (isEn ? 'Verified — sent to sales review' : '核实通过，已转入销售审核')
        : (isEn ? 'Marked as failed — sent back to driver' : '已标记核实不通过，打回司机'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '操作失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent style={{ maxWidth: 520 }}>
      <DialogHeader>
        <DialogTitle style={{ color: PURPLE }}>
          {isEn ? 'Warehouse Check' : '仓库核实'} — {item.restaurantName}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-3">
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-900">{item.productName}</span>
            <span className="text-orange-700 font-semibold">×{item.quantity}</span>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            {isEn ? 'Driver' : '司机'}：{item.driverName} · {isEn ? 'Reported' : '上报时间'}：{item.createdAt ? new Date(item.createdAt).toLocaleString(isEn ? 'en-GB' : 'zh-CN') : '—'}
          </div>
          {item.reason && <div className="mt-1 text-xs text-orange-600">{isEn ? 'Reason: ' : '原因：'}{item.reason}</div>}
          <div className="mt-1 text-xs text-blue-600">
            {item.actionType === 'exchange' ? (isEn ? 'Exchange' : '换货') : (isEn ? 'Return' : '退货')}
          </div>
        </div>

        {item.photo && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500 font-medium">{isEn ? 'Photo Evidence' : '现场照片'}</p>
            <img
              src={item.photo}
              alt="return-photo"
              className="w-24 h-24 object-cover rounded border border-gray-200 cursor-pointer"
              onClick={() => window.open(item.photo, '_blank')}
            />
          </div>
        )}

        {item.driverSignature ? (
          <div className="space-y-1">
            <p className="text-xs text-gray-500 font-medium">{isEn ? 'Driver Signature' : '司机签名'}</p>
            <div className="inline-block rounded border bg-white p-2">
              <img src={item.driverSignature} alt="driver-signature" className="h-14 object-contain" />
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-400">{isEn ? 'No driver signature (reported before this feature shipped)' : '无司机签名（此功能上线前提交的记录）'}</p>
        )}

        <div className="space-y-1">
          <label className="text-xs text-gray-500 font-medium">{isEn ? 'Note (required to fail check)' : '核实备注（核实不通过时必填）'}</label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            placeholder={isEn ? 'e.g. goods actually still on the van, driver mis-reported' : '例如：货其实还在车上，司机记录有误'}
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:border-purple-400 resize-none"
          />
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>{isEn ? 'Cancel' : '取消'}</Button>
        <Button onClick={() => act('reject')} disabled={saving} variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
          {isEn ? 'Check Failed' : '核实不通过'}
        </Button>
        <Button onClick={() => act('verify')} disabled={saving} style={{ background: PURPLE, borderColor: PURPLE }} className="text-white hover:opacity-90">
          {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Verified' : '核实通过')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
