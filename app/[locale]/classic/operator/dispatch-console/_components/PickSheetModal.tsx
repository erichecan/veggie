'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { restaurantColor } from './colors'

const SEQ = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫'

interface SheetItem { productName: string; qty: number; uomName?: string; restaurantName: string }
interface SheetPallet { seq: number; label: string | null; skuCount: number; qtyCount: number; items: SheetItem[] }
interface Sheet {
  waveName: string | null; driverName: string; timeOfDay: string | null; batchNum: number | null
  waveType: string | null; waveDate: string | null; palletCount: number; totalSku: number; totalQty: number
  pallets: SheetPallet[]
}

export default function PickSheetModal({ waveId, onClose }: { waveId: string; onClose: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSheet(await apiGet<Sheet>(`/api/waves/${waveId}/pick-sheet`))
    } catch {
      toast.error('加载拣货单失败')
    } finally {
      setLoading(false)
    }
  }, [waveId])

  useEffect(() => { load() }, [load])

  const timeText = sheet?.timeOfDay === 'am' ? '上午' : sheet?.timeOfDay === 'pm' ? '下午' : '—'

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-start justify-center p-7 overflow-auto print:bg-white print:p-0" onClick={onClose}>
      <div id="pick-sheet" className="bg-white w-full max-w-[660px] rounded-xl overflow-hidden print:max-w-none print:rounded-none" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b flex items-center justify-between print:hidden" style={{ borderColor: '#e5e7eb' }}>
          <h3 className="text-base font-semibold">🖨 拣货单{sheet ? ` · ${sheet.driverName}` : ''}</h3>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: '#21a67a' }}>打印</button>
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-medium border" style={{ borderColor: '#e5e7eb' }}>关闭</button>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-400">加载中…</div>
        ) : !sheet ? null : (
          <div className="p-5 max-h-[72vh] overflow-auto print:max-h-none print:overflow-visible">
            {/* 抬头 */}
            <div className="flex gap-4 flex-wrap text-xs text-gray-500 pb-3 mb-4 border-b border-dashed" style={{ borderColor: '#e5e7eb' }}>
              <span>日期：<b className="text-gray-800">{sheet.waveDate ?? '—'}</b></span>
              <span>时段：<b className="text-gray-800">{timeText}</b></span>
              <span>司机：<b className="text-gray-800">{sheet.driverName || '—'}</b></span>
              <span>类型：<b className="text-gray-800">{sheet.waveType === 'bulk' ? '大货' : sheet.waveType === 'loose' ? '散货' : '—'}</b></span>
              <span>托盘：<b className="text-gray-800">{sheet.palletCount}</b></span>
              <span>合计：<b className="text-gray-800">{sheet.totalSku} SKU · {sheet.totalQty} 件</b></span>
            </div>

            {sheet.pallets.length === 0 && <div className="text-center text-gray-400 py-8">尚未编排托盘</div>}

            {sheet.pallets.map(p => (
              <div key={p.seq} className="border rounded-lg mb-3 overflow-hidden" style={{ borderColor: '#e5e7eb' }}>
                <div className="bg-gray-100 px-3 py-2 font-bold flex justify-between items-center text-sm">
                  <span><span className="inline-flex items-center justify-center w-5 h-5 rounded text-white text-[11px] mr-1.5" style={{ background: '#7c3aed' }}>{SEQ[p.seq - 1] ?? p.seq}</span>托盘 {p.seq}</span>
                  <span className="text-xs font-normal text-gray-500">{p.skuCount} SKU · {p.qtyCount} 件</span>
                </div>
                {p.items.map((it, i) => (
                  <div key={i} className="flex items-center px-3 py-1.5 border-t text-sm" style={{ borderColor: '#f0f0f0' }}>
                    <span className="w-4 h-4 border rounded mr-2.5 flex-none" style={{ borderColor: '#9ca3af' }} />
                    <span className="flex-1">{it.productName}</span>
                    <span className="font-bold mx-3">×{it.qty}{it.uomName ? ` ${it.uomName}` : ''}</span>
                    <span className="text-gray-400 text-[11px] w-20 text-right flex items-center justify-end gap-1">
                      <i className="w-2 h-2 rounded-full inline-block" style={{ background: restaurantColor(it.restaurantName) }} />{it.restaurantName}
                    </span>
                  </div>
                ))}
              </div>
            ))}

            <div className="text-xs text-gray-500 pt-2">拣货员签名：____________</div>
          </div>
        )}
      </div>
    </div>
  )
}
