'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'

/**
 * 司机收车回传（台账 C8）
 *
 * 四个数字都**预填系统值**，司机核对后改成实际的再交。空着让人从头填的话，
 * 收车时又累又赶，多半是照着系统数字抄一遍 —— 那样对账就永远对得上，
 * 也就永远发现不了问题。预填 + 差异高亮才让「核对」这个动作有意义。
 */

interface Derived {
  tripIds: string[]
  cashCollected: number
  onlineCollected: number
  orderTotal: number
  returnCount: number
  exchangeCount: number
  stopCount: number
  unsettledTripCount: number
}
interface Submitted {
  id: string
  cashCollected: string | number
  orderTotal: string | number
  returnCount: number
  exchangeCount: number
  note: string | null
  status: string
  submittedAt: string
  submittedByName: string
}
interface Diff {
  field: string; label: string; declared: number; system: number; diff: number
}
interface Payload {
  date: string
  system: Derived
  submitted: Submitted | null
  diffs: Diff[]
}

const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`

export default function DailyReportCard({ date, isEn = false }: { date: string; isEn?: boolean }) {
  const [data, setData] = useState<Payload | null>(null)
  const [form, setForm] = useState({ cashCollected: '', orderTotal: '', returnCount: '', exchangeCount: '', note: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    apiGet<Payload>(`/api/driver-reports/daily?date=${date}`)
      .then(d => {
        setData(d)
        if (!d.submitted) {
          setForm({
            cashCollected: String(d.system.cashCollected),
            orderTotal: String(d.system.orderTotal),
            returnCount: String(d.system.returnCount),
            exchangeCount: String(d.system.exchangeCount),
            note: '',
          })
        }
      })
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load today’s report' : '读取当日回传失败')))
  }, [date, isEn])

  useEffect(() => { load() }, [load])

  const submit = async () => {
    setSaving(true)
    try {
      await apiPost('/api/driver-reports/daily', {
        date,
        cashCollected: Number(form.cashCollected),
        orderTotal: Number(form.orderTotal),
        returnCount: Number(form.returnCount),
        exchangeCount: Number(form.exchangeCount),
        note: form.note || undefined,
      })
      toast.success(isEn ? 'Today’s report submitted' : '当日回传已提交')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to submit' : '提交失败'))
    } finally {
      setSaving(false)
    }
  }

  if (!data) return <div className="border rounded-lg p-4 text-sm text-gray-400">{isEn ? 'Loading today’s report…' : '加载当日回传…'}</div>

  const s = data.system
  const done = !!data.submitted

  const fields: Array<{ key: keyof typeof form; label: string; sys: number; money?: boolean }> = [
    { key: 'cashCollected', label: isEn ? 'Cash Collected' : '收回现金', sys: s.cashCollected, money: true },
    { key: 'orderTotal', label: isEn ? 'Order Total' : '订单总额', sys: s.orderTotal, money: true },
    { key: 'returnCount', label: isEn ? 'Return Count' : '退货笔数', sys: s.returnCount },
    { key: 'exchangeCount', label: isEn ? 'Exchange Count' : '换货笔数', sys: s.exchangeCount },
  ]

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <div>
          <div className="font-medium text-gray-900">{isEn ? 'End-of-Day Report' : '收车回传'} · {data.date}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {isEn
              ? `${s.tripIds.length} trips today · ${s.stopCount} delivery stops`
              : `今日 ${s.tripIds.length} 趟 · ${s.stopCount} 个送达站点`}
            {s.unsettledTripCount > 0 && (
              <span className="text-amber-700 ml-1">
                · {isEn ? `${s.unsettledTripCount} trips not yet settled` : `${s.unsettledTripCount} 趟还没交账`}
              </span>
            )}
          </div>
        </div>
        {done && (
          <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-800">
            {data.submitted!.status === 'confirmed'
              ? (isEn ? 'Confirmed by Finance' : '财务已确认')
              : (isEn ? 'Submitted' : '已提交')}
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {done ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {fields.map(f => {
                const declared = data.submitted![f.key as keyof Submitted]
                return (
                  <div key={f.key}>
                    <div className="text-xs text-gray-500">{f.label}</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {f.money ? eur(declared) : String(declared)}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="text-xs text-gray-400">
              {isEn
                ? `Submitted by ${data.submitted!.submittedByName} at ${formatDateTime(data.submitted!.submittedAt)}`
                : `${formatDateTime(data.submitted!.submittedAt)} 由 ${data.submitted!.submittedByName} 提交`}
              {data.submitted!.note && <span className="ml-1">· {data.submitted!.note}</span>}
            </div>
            {data.diffs.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm">
                <div className="font-medium text-amber-900 mb-1">{isEn ? "Doesn't match system records:" : '与系统记录对不上：'}</div>
                {data.diffs.map(d => (
                  <div key={d.field} className="text-amber-800">
                    {isEn
                      ? <>{d.label}: you reported {d.field.includes('Count') ? d.declared : eur(d.declared)}, system shows {d.field.includes('Count') ? d.system : eur(d.system)}
                        <span className="ml-1 font-medium">(diff {d.field.includes('Count') ? d.diff : eur(d.diff)})</span></>
                      : <>{d.label}：你报 {d.field.includes('Count') ? d.declared : eur(d.declared)}
                        ，系统 {d.field.includes('Count') ? d.system : eur(d.system)}
                        <span className="ml-1 font-medium">（差 {d.field.includes('Count') ? d.diff : eur(d.diff)}）</span></>}
                  </div>
                ))}
                <div className="text-xs text-amber-700 mt-1">
                  {isEn
                    ? 'This can also happen if the trip was changed after submission (return review, late payment entry) — Finance will reconcile it.'
                    : '提交之后行程被改过（退货审核、补录收款）也会这样，交给财务核对即可'}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {fields.map(f => (
                <div key={f.key}>
                  <label className="text-xs text-gray-500 block mb-1">{f.label}</label>
                  <input
                    type="number"
                    min={0}
                    step={f.money ? '0.01' : '1'}
                    value={form[f.key]}
                    onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm tabular-nums"
                  />
                  <div className={`text-xs mt-0.5 ${
                    Number(form[f.key]) !== f.sys ? 'text-amber-700 font-medium' : 'text-gray-400'
                  }`}>
                    {isEn ? 'System' : '系统'}：{f.money ? eur(f.sys) : f.sys}
                    {Number(form[f.key]) !== f.sys && (isEn ? ' ← differs from what you entered' : ' ← 与你填的不一致')}
                  </div>
                </div>
              ))}
            </div>
            <input
              value={form.note}
              onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
              placeholder={isEn ? 'Note (explain any discrepancy)' : '备注（对不上时说明原因）'}
              className="w-full border rounded px-2 py-1.5 text-sm"
            />
            {s.unsettledTripCount > 0 && (
              <div className="text-xs text-amber-700">
                {isEn
                  ? `${s.unsettledTripCount} trips are still not settled — submitting now won't include their money in the system value`
                  : `还有 ${s.unsettledTripCount} 趟没交账，现在提交的话这几趟的钱不会算进系统值里`}
              </div>
            )}
            <button
              onClick={submit}
              disabled={saving}
              className="px-4 py-2 bg-purple-700 text-white rounded text-sm disabled:opacity-50"
            >
              {saving ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? "Submit Today's Report" : '提交当日回传')}
            </button>
            <p className="text-xs text-gray-400">
              {isEn ? 'You can only submit once per day. Contact Finance if you need to correct it afterwards.' : '一天只能提交一次。提交后如需更正，请联系财务。'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
