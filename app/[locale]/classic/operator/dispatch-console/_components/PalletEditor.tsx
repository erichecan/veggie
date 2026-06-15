'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { restaurantColor } from './colors'
import { fmtQty } from './num'

const PURPLE = '#875A7B'

interface PalletItem {
  orderId: string; orderCode?: string; restaurantId: string; restaurantName: string
  productId: string; productName: string; qty: number; uomName?: string
}
interface PalletDraft { id?: string; seq: number; label: string | null; items: PalletItem[] }
interface Board { pool: PalletItem[]; pallets: PalletDraft[] }
interface DragData { srcType: 'pool' | 'pallet'; srcIdx: number; key: string }

const itemKey = (x: PalletItem) => `${x.orderId}::${x.productId}`
const SEQ = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫'

export default function PalletEditor({
  waveId, onClose, onSaved, onPrint,
}: { waveId: string; onClose: () => void; onSaved: () => void; onPrint: () => void }) {
  const [board, setBoard] = useState<Board>({ pool: [], pallets: [] })
  const [driverName, setDriverName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiGet<{
        wave: { driverName: string | null }
        pallets: PalletDraft[]
        pool: PalletItem[]
      }>(`/api/waves/${waveId}/pallets`)
      setDriverName(r.wave.driverName ?? '')
      setBoard({ pool: r.pool, pallets: r.pallets })
    } catch {
      toast.error('加载托盘失败')
    } finally {
      setLoading(false)
    }
  }, [waveId])

  useEffect(() => { load() }, [load])

  function move(data: DragData, dest: { type: 'pool' | 'pallet'; idx: number }) {
    setBoard(b => {
      const pool = [...b.pool]
      const pallets = b.pallets.map(p => ({ ...p, items: [...p.items] }))
      let item: PalletItem | undefined
      if (data.srcType === 'pool') {
        const i = pool.findIndex(x => itemKey(x) === data.key)
        if (i >= 0) item = pool.splice(i, 1)[0]
      } else {
        const arr = pallets[data.srcIdx]?.items
        const i = arr?.findIndex(x => itemKey(x) === data.key) ?? -1
        if (i >= 0) item = arr.splice(i, 1)[0]
      }
      if (!item) return b
      if (dest.type === 'pool') pool.push(item)
      else pallets[dest.idx].items.push(item)
      return { pool, pallets }
    })
  }

  function addPallet() {
    setBoard(b => ({ ...b, pallets: [...b.pallets, { seq: b.pallets.length + 1, label: null, items: [] }] }))
  }

  function delPallet(idx: number) {
    setBoard(b => {
      const removed = b.pallets[idx]
      const pool = [...b.pool, ...removed.items]
      const pallets = b.pallets.filter((_, i) => i !== idx).map((p, i) => ({ ...p, seq: i + 1 }))
      return { pool, pallets }
    })
  }

  async function save(thenPrint: boolean) {
    setSaving(true)
    try {
      await apiPut(`/api/waves/${waveId}/pallets`, {
        pallets: board.pallets.map(p => ({ seq: p.seq, label: p.label, items: p.items })),
      })
      toast.success('托盘已保存')
      if (thenPrint) onPrint()
      else onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // 餐馆图例
  const allRest = new Set<string>()
  for (const it of board.pool) allRest.add(it.restaurantName)
  for (const p of board.pallets) for (const it of p.items) allRest.add(it.restaurantName)

  const onDragStart = (e: React.DragEvent, d: DragData) => {
    e.dataTransfer.setData('application/json', JSON.stringify(d))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDropTo = (e: React.DragEvent, dest: { type: 'pool' | 'pallet'; idx: number }) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/json')
    if (raw) move(JSON.parse(raw) as DragData, dest)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-7 overflow-auto" onClick={onClose}>
      <div className="bg-white w-full max-w-[920px] rounded-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* 头 */}
        <div className="px-5 py-3.5 border-b flex items-center justify-between" style={{ borderColor: '#e5e7eb' }}>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <span className="w-6 h-6 rounded-full text-white inline-flex items-center justify-center text-[11px] font-bold" style={{ background: PURPLE }}>{driverName[0] ?? '?'}</span>
            {driverName} · 托盘编排
          </h3>
          <div className="flex gap-2">
            <button onClick={addPallet} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: PURPLE }}>+ 添加托盘</button>
            <button onClick={() => save(true)} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm font-medium border disabled:opacity-50" style={{ borderColor: '#e5e7eb' }}>🖨 打印拣货单</button>
            <button onClick={() => save(false)} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ background: '#21a67a' }}>{saving ? '保存中…' : '保存'}</button>
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-medium border" style={{ borderColor: '#e5e7eb' }}>关闭</button>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-400">加载中…</div>
        ) : (
          <div className="max-h-[72vh] overflow-auto">
            {/* 图例 */}
            <div className="flex gap-3 flex-wrap text-[11px] text-gray-500 px-4 pt-3">
              {[...allRest].map(r => (
                <span key={r} className="flex items-center gap-1.5">
                  <i className="w-2 h-2 rounded-full inline-block" style={{ background: restaurantColor(r) }} />{r}
                </span>
              ))}
              <span className="text-gray-400">· 颜色=货来自哪家；一盘可混装多家，货可在盘间互拖</span>
            </div>

            {/* 待分盘池 */}
            <div
              className="m-4 border border-dashed rounded-lg bg-gray-50 p-3"
              style={{ borderColor: '#cbd5e1' }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => onDropTo(e, { type: 'pool', idx: -1 })}
            >
              <div className="text-xs font-semibold text-gray-500 mb-2 flex justify-between">
                <span>待分盘商品池（拖到下方任意托盘）</span><span>剩 {board.pool.length} 项</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {board.pool.length === 0 && <span className="text-xs text-gray-400">已全部入盘</span>}
                {board.pool.map(it => (
                  <span
                    key={itemKey(it)}
                    draggable
                    onDragStart={e => onDragStart(e, { srcType: 'pool', srcIdx: -1, key: itemKey(it) })}
                    className="flex items-center bg-white border rounded-lg px-2 py-1 text-xs cursor-grab"
                    style={{ borderColor: '#e5e7eb' }}
                  >
                    <i className="w-2 h-2 rounded-full inline-block mr-1.5" style={{ background: restaurantColor(it.restaurantName) }} />
                    {it.productName}<span className="font-semibold ml-1">×{it.qty}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* 托盘 */}
            <div className="px-4 pb-2 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))' }}>
              {board.pallets.map((p, idx) => {
                const qty = p.items.reduce((s, it) => s + it.qty, 0)
                const rest = new Set(p.items.map(it => it.restaurantName))
                return (
                  <div
                    key={idx}
                    className="border rounded-lg bg-white flex flex-col"
                    style={{ borderColor: '#e5e7eb' }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => onDropTo(e, { type: 'pallet', idx })}
                  >
                    <div className="px-3 py-2 border-b flex justify-between items-center bg-gray-50 rounded-t-lg" style={{ borderColor: '#e5e7eb' }}>
                      <span className="font-bold text-sm flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded text-white inline-flex items-center justify-center text-[11px] font-bold" style={{ background: '#7c3aed' }}>{SEQ[p.seq - 1] ?? p.seq}</span>
                        托盘 {p.seq}
                      </span>
                      <button onClick={() => delPallet(idx)} className="text-red-600 text-xs hover:underline">✕ 删盘</button>
                    </div>
                    <div className="p-2 min-h-[70px] flex flex-col gap-1">
                      {p.items.length === 0 && <div className="flex-1 flex items-center justify-center text-gray-400 text-xs min-h-[60px]">拖商品到此盘</div>}
                      {p.items.map(it => (
                        <div
                          key={itemKey(it)}
                          draggable
                          onDragStart={e => onDragStart(e, { srcType: 'pallet', srcIdx: idx, key: itemKey(it) })}
                          className="flex justify-between items-center text-xs px-1.5 py-1 rounded hover:bg-gray-50 cursor-grab"
                        >
                          <span className="flex items-center">
                            <span className="text-gray-300 mr-1.5">⠿</span>
                            <i className="w-2 h-2 rounded-full inline-block mr-1.5" style={{ background: restaurantColor(it.restaurantName) }} />
                            {it.productName} <span className="font-semibold ml-1">×{it.qty}</span>
                          </span>
                          <span className="text-gray-400 text-[11px]">{it.restaurantName}</span>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 py-1.5 border-t text-[11px] text-gray-500 flex justify-between" style={{ borderColor: '#e5e7eb' }}>
                      <span>{rest.size} 家 · {p.items.length} SKU</span><span>{fmtQty(qty)} 件</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="px-4 py-3 bg-amber-50 border-t text-[11px] text-amber-800" style={{ borderColor: '#fde68a' }}>
              🚐 托盘按 ①②③ 排序=卸货/装车顺序：①最先卸（装车门口最易取处），序号越大越往车厢里装。货可在盘间互拖，一盘可拼多家。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
