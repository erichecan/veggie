'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPatch } from '@/lib/api'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

interface Category { id: string; name: string; nameZh?: string | null }

interface StockTakeLine {
  id: string
  productId: string
  productName: string
  systemQty: string | number
  countedQty: string | number | null
  diffQty: string | number | null
}

interface StockTake {
  id: string
  name: string
  status: 'DRAFT' | 'DONE' | 'CANCELLED'
  takenAt: string
  createdBy?: string | null
  notes?: string | null
  createdAt: string
  lines?: StockTakeLine[]
  _count?: { lines: number }
}

const STATUS_LABEL: Record<StockTake['status'], { text: string; cls: string }> = {
  DRAFT: { text: '盘点中', cls: 'bg-amber-100 text-amber-800' },
  DONE: { text: '已完成', cls: 'bg-green-100 text-green-800' },
  CANCELLED: { text: '已取消', cls: 'bg-gray-100 text-gray-500' },
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v))

export default function StockTakePage() {
  const [list, setList] = useState<StockTake[]>([])
  const [detail, setDetail] = useState<StockTake | null>(null)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)

  const loadList = useCallback(() => {
    apiGet<{ items: StockTake[] }>('/api/stock-takes')
      .then((d) => setList(d.items ?? []))
      .catch((e) => toast.error(e.message))
  }, [])

  useEffect(() => {
    loadList()
    apiGet<Category[]>('/api/product-categories').then(setCategories).catch(() => {})
  }, [loadList])

  async function openDetail(id: string) {
    try {
      const st = await apiGet<StockTake>(`/api/stock-takes/${id}`)
      setDetail(st)
      const init: Record<string, string> = {}
      for (const l of st.lines ?? []) {
        init[l.id] = l.countedQty === null || l.countedQty === undefined ? '' : String(num(l.countedQty))
      }
      setCounts(init)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function handleCreate() {
    if (creating) return
    if (selectedCats.size === 0) { toast.error('请至少选择一个分类'); return }
    setCreating(true)
    try {
      const created = await apiPost<StockTake>('/api/stock-takes', {
        categoryIds: [...selectedCats],
        notes: notes.trim() || undefined,
      })
      toast.success(`盘点单 ${created.name} 已创建（${created.lines?.length ?? 0} 个商品）`)
      setCreateOpen(false)
      setSelectedCats(new Set())
      setNotes('')
      loadList()
      openDetail(created.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function saveCounts(silent = false) {
    if (!detail || saving) return false
    setSaving(true)
    try {
      const payload = (detail.lines ?? []).map((l) => ({
        lineId: l.id,
        countedQty: counts[l.id]?.trim() === '' || counts[l.id] === undefined ? null : Number(counts[l.id]),
      }))
      const bad = payload.find((c) => c.countedQty !== null && (!Number.isFinite(c.countedQty) || c.countedQty! < 0))
      if (bad) { toast.error('实盘数量必须是 ≥ 0 的数字'); return false }
      const updated = await apiPatch<StockTake>(`/api/stock-takes/${detail.id}`, {
        action: 'save_counts', counts: payload,
      })
      setDetail(updated)
      if (!silent) toast.success('已保存')
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function complete() {
    if (!detail || saving) return
    const filled = Object.values(counts).filter((v) => v.trim() !== '').length
    if (filled === 0) { toast.error('尚未录入任何实盘数量'); return }
    const diffs = (detail.lines ?? []).filter((l) => {
      const c = counts[l.id]?.trim()
      return c !== '' && c !== undefined && Number(c) !== num(l.systemQty)
    }).length
    if (!window.confirm(`已录入 ${filled} 行，其中 ${diffs} 行有差异。完成后将生成库存调整，且不可再修改。确认完成？`)) return
    const ok = await saveCounts(true)
    if (!ok) return
    setSaving(true)
    try {
      const updated = await apiPatch<StockTake>(`/api/stock-takes/${detail.id}`, { action: 'complete' })
      setDetail(updated)
      toast.success('盘点完成，库存已调整')
      loadList()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function cancel() {
    if (!detail || saving) return
    if (!window.confirm(`确认取消盘点单 ${detail.name}？`)) return
    setSaving(true)
    try {
      await apiPatch(`/api/stock-takes/${detail.id}`, { action: 'cancel' })
      toast.success('已取消')
      setDetail(null)
      loadList()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // ── 详情视图 ─────────────────────────────────────────────────────────────
  if (detail) {
    const lines = detail.lines ?? []
    const isDraft = detail.status === 'DRAFT'
    const filledCount = lines.filter((l) =>
      isDraft ? counts[l.id]?.trim() !== '' && counts[l.id] !== undefined : l.countedQty !== null,
    ).length
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => { setDetail(null); loadList() }}>← 返回列表</Button>
            <h1 className="text-xl font-semibold">{detail.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded ${STATUS_LABEL[detail.status].cls}`}>
              {STATUS_LABEL[detail.status].text}
            </span>
            <span className="text-sm text-gray-500">
              {formatDateOnly(detail.takenAt)} · {lines.length} 个商品 · 已录 {filledCount}
            </span>
          </div>
          {isDraft && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>取消盘点</Button>
              <Button variant="outline" size="sm" onClick={() => saveCounts()} disabled={saving}>暂存</Button>
              <Button size="sm" style={{ backgroundColor: PURPLE }} className="text-white" onClick={complete} disabled={saving}>
                完成盘点
              </Button>
            </div>
          )}
        </div>
        {detail.notes && <p className="text-sm text-gray-500 mb-3">备注：{detail.notes}</p>}
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">商品</th>
                <th className="px-3 py-2 font-medium text-right w-32">系统库存</th>
                <th className="px-3 py-2 font-medium text-right w-36">实盘数量</th>
                <th className="px-3 py-2 font-medium text-right w-28">差异</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const sys = num(l.systemQty) ?? 0
                const cRaw = isDraft ? counts[l.id] : (l.countedQty === null ? '' : String(num(l.countedQty)))
                const counted = cRaw?.trim() === '' || cRaw === undefined ? null : Number(cRaw)
                const diff = counted === null ? null : Math.round((counted - sys) * 1000) / 1000
                return (
                  <tr key={l.id} className="border-t">
                    <td className="px-3 py-1.5">{l.productName}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${sys < 0 ? 'text-red-600 font-medium' : sys === 0 ? 'text-amber-600' : ''}`}>
                      {sys}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {isDraft ? (
                        <input
                          type="number"
                          min={0}
                          step="any"
                          className="w-28 border rounded px-2 py-1 text-right text-sm"
                          value={counts[l.id] ?? ''}
                          placeholder="未盘"
                          onChange={(e) => setCounts((prev) => ({ ...prev, [l.id]: e.target.value }))}
                        />
                      ) : (
                        <span className="tabular-nums">{counted === null ? '未盘' : counted}</span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${diff === null ? 'text-gray-400' : diff < 0 ? 'text-red-600' : diff > 0 ? 'text-green-700' : ''}`}>
                      {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── 列表视图 ─────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">库存盘点</h1>
        <Button style={{ backgroundColor: PURPLE }} className="text-white" onClick={() => setCreateOpen(true)}>
          新建盘点单
        </Button>
      </div>
      {list.length === 0 ? (
        <div className="text-center text-gray-400 py-16 border rounded">
          还没有盘点单。点右上角「新建盘点单」，按分类圈定范围开始盘点。
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">编号</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">盘点日期</th>
                <th className="px-3 py-2 font-medium text-right">商品数</th>
                <th className="px-3 py-2 font-medium">创建人</th>
                <th className="px-3 py-2 font-medium">备注</th>
              </tr>
            </thead>
            <tbody>
              {list.map((st) => (
                <tr key={st.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(st.id)}>
                  <td className="px-3 py-2 font-medium" style={{ color: PURPLE }}>{st.name}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_LABEL[st.status].cls}`}>
                      {STATUS_LABEL[st.status].text}
                    </span>
                  </td>
                  <td className="px-3 py-2">{formatDateOnly(st.takenAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{st._count?.lines ?? '—'}</td>
                  <td className="px-3 py-2">{st.createdBy ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 max-w-48 truncate">{st.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>新建盘点单</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="mb-2 block">盘点范围（选分类，单张上限 500 个商品）</Label>
              <div className="max-h-56 overflow-y-auto border rounded p-2 space-y-1">
                {categories.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded">
                    <input
                      type="checkbox"
                      checked={selectedCats.has(c.id)}
                      onChange={(e) => {
                        setSelectedCats((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(c.id); else next.delete(c.id)
                          return next
                        })
                      }}
                    />
                    {c.nameZh ? `${c.nameZh} (${c.name})` : c.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="stk-notes" className="mb-1 block">备注（可选）</Label>
              <Input id="stk-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="如：月末例行盘点" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button style={{ backgroundColor: PURPLE }} className="text-white" onClick={handleCreate} disabled={creating}>
              {creating ? '创建中…' : '创建并开始盘点'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
