'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { Trip } from '@/lib/types'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { flattenPending, VerifyReturnDialog, type PendingReturn } from '@/components/warehouse/VerifyReturnDialog'

const PURPLE = '#875A7B'

export default function WarehouseReturnsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [rows, setRows] = useState<PendingReturn[]>([])
  const [loading, setLoading] = useState(false)
  const [reviewing, setReviewing] = useState<PendingReturn | null>(null)

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<Record<string, unknown>[]>('/api/trips')
      setRows(flattenPending(data as unknown as Trip[]))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{isEn ? 'Warehouse Return Check' : '退换货仓库核实'}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {isEn ? 'Next-morning check: confirm the goods the driver reported are physically on the van and match the paper slip.' : '次日核对：确认司机上报的退换货实物真的在车上，且与纸质单一致。'}
          </p>
        </div>
        <Button variant="outline" onClick={load}>{isEn ? 'Refresh' : '刷新'}</Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-gray-400">
          <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
          {isEn ? 'Loading…' : '加载中…'}
        </div>
      ) : rows.length === 0 ? (
        <div className="py-24 text-center text-gray-400 text-sm">{isEn ? 'Nothing pending warehouse check' : '暂无待核实的退换货'}</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <button
              key={`${r.tripId}-${r.restaurantId}-${r.productId}-${i}`}
              onClick={() => setReviewing(r)}
              className="w-full text-left bg-white rounded-lg border border-gray-200 px-4 py-3 hover:border-purple-300 hover:shadow-sm transition-all flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{r.restaurantName}</span>
                  <span className="text-xs text-gray-400">{r.driverName}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.actionType === 'exchange' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>
                    {r.actionType === 'exchange' ? (isEn ? 'Exchange' : '换货') : (isEn ? 'Return' : '退货')}
                  </span>
                </div>
                <div className="text-sm text-gray-600 mt-0.5">{r.productName} ×{r.quantity}</div>
                {r.reason && <div className="text-xs text-orange-600 mt-0.5">{r.reason}</div>}
              </div>
              <span className="text-xs text-gray-400 shrink-0">
                {r.createdAt ? new Date(r.createdAt).toLocaleDateString(isEn ? 'en-GB' : 'zh-CN') : '—'}
              </span>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null) }}>
        {reviewing && <VerifyReturnDialog item={reviewing} onClose={() => setReviewing(null)} onSaved={load} />}
      </Dialog>
    </div>
  )
}
