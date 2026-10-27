'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { openAuthedPdf } from '@/lib/print/open-pdf'
import type { Order } from '@/lib/types'
import type { ReturnRow, ReturnOrderLineRow } from '@/lib/accounting/returns'
import { SearchableDropdown } from '@/components/shared/searchable-dropdown'
import { SortTh, sortRows, type SortDir } from '@/components/shared/sort-th'
import { DatePicker } from '@/components/ui/date-picker'

const ACCENT = '#875A7B'
const TIME_TEXT: Record<string, string> = { am: '上午', pm: '下午' }

type SortKey = 'code' | 'deliveryDate' | 'restaurantName' | 'timeOfDay' | 'driver' | 'amount' | 'paymentMethod' | 'returnStatus' | 'scanOrder' | 'daysOut'
type CardKey = 'open' | 'returned' | 'issue' | 'pending' | 'cashPending' | 'pendingConfirm'

interface ReturnsSummary {
  pending: number
  issue: number
  returned: number
  openAmount: number
  cashOpenAmount: number
  oldestDays: number
  byDriver: Array<{ driver: string; count: number; amount: number; cash: number; oldestDays: number }>
  drivers: string[]
}

interface ReturnsResponse { today: string; floor: string; rows: ReturnRow[]; summary: ReturnsSummary }

const isCash = (r: { paymentMethod: string }) => r.paymentMethod.toUpperCase() === 'CASH'

/**
 * 会计核销页「单」板块。
 * 20261021 改造（客户：「列表要一直在，看得出还有多少单司机送出去了还没回来核销」）：
 *   - 原来只看「今天送货日期」的单，当天没送货就是空的，前几天没回的单只能去最底下折叠的「查漏单」里翻；
 *     还把已确认/已排波次（货根本没出仓）的单也算成「未回」。
 *   - 现在：「待核销」tab = 所有已出发（配送中/已完成/已锁定）、还没核销的单，不限日期；刚核销的在这里留 24 小时；
 *     「已核销」tab = 全部已核销，可按司机 / 送货日期筛选、按单号/客户搜索。数据见 lib/accounting/returns.ts。
 *   - 未核销清单可按日期或按司机分组打印（服务端 PDF：/api/print/returns-pdf）。
 * 两步核销不变：扫中先标记「待确认」，会计再点「确认核销」才落库；单据有问题点「退回核实」写明原因。
 */
export function WriteOffBoard({ businessDate }: { businessDate: string | null }) {
  const [tab, setTab] = useState<'open' | 'returned'>('open')
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {([['open', '待核销'], ['returned', '已核销']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`writeoff-tab-${k}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            style={tab === k ? { borderColor: ACCENT, color: ACCENT } : {}}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'open' ? <OpenReturns businessDate={businessDate} /> : <ReturnedList />}
    </div>
  )
}

function OpenReturns({ businessDate }: { businessDate: string | null }) {
  const [data, setData] = useState<ReturnsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [filterDriver, setFilterDriver] = useState('')
  const [filterTime, setFilterTime] = useState('')
  const [filterPayment, setFilterPayment] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'PENDING' | 'RETURNED' | 'ISSUE'>('all')
  const [printGroup, setPrintGroup] = useState<'date' | 'driver'>('date')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [invoiceLoading, setInvoiceLoading] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const [scanSearching, setScanSearching] = useState(false)
  const [scanMsg, setScanMsg] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('deliveryDate')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [flashId, setFlashId] = useState<string | null>(null)
  const [activeCard, setActiveCard] = useState<CardKey | null>(null)
  const [issueMode, setIssueMode] = useState<'batch' | string | null>(null)
  const [issueNote, setIssueNote] = useState('')
  const [qtyEditRow, setQtyEditRow] = useState<ReturnRow | null>(null)
  const scanSeqCounter = useRef(0)
  const [scanSeq, setScanSeq] = useState<Record<string, number>>({})
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const tableRef = useRef<HTMLDivElement>(null)

  // 日期区间走服务端（送货日期）；司机/上午下午/付款方式/状态在已拉回的待核销单上筛——这批单量不大
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const p = new URLSearchParams({ tab: 'open' })
      if (from) p.set('from', from)
      if (to) p.set('to', to)
      setData(await apiGet<ReturnsResponse>(`/api/accounting/returns?${p}`))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const rows = useMemo(() => data?.rows ?? [], [data])
  const today = data?.today ?? businessDate

  function markScanned(ids: string[]) {
    setScanSeq(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        if (!(id in next)) { scanSeqCounter.current += 1; next[id] = scanSeqCounter.current; changed = true }
      }
      return changed ? next : prev
    })
  }

  function flashRow(id: string) {
    setFlashId(id)
    setTimeout(() => setFlashId(null), 1400)
    setTimeout(() => rowRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30)
  }

  // 连续扫码时上一条提示的计时器不能把新提示提前清掉
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function flash(type: 'ok' | 'err' | 'warn', text: string, ms = 4500) {
    setScanMsg({ type, text })
    if (msgTimer.current) clearTimeout(msgTimer.current)
    msgTimer.current = setTimeout(() => setScanMsg(null), ms)
  }

  function selectFound(target: ReturnRow) {
    if (target.returnStatus === 'RETURNED') flash('warn', `${target.code} 已经核销过了`)
    else if (target.returnStatus === 'ISSUE') flash('warn', `${target.code} 之前标记了「有问题」，点该行「重新核对」`)
    else {
      setSelected(prev => new Set(prev).add(target.id))
      markScanned([target.id])
      flash('ok', `✅ ${target.code} 已标记待确认`)
    }
    flashRow(target.id)
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault()
    const code = scanInput.trim()
    if (!code) return
    const codeUpper = code.toUpperCase()
    const local = rows.find(o => o.code?.toUpperCase() === codeUpper) ?? (visible.length === 1 ? visible[0] : undefined)
    if (local) {
      // 扫中的单如果被下拉筛选挡住了，清掉筛选让它露出来
      setFilterDriver(''); setFilterTime(''); setFilterPayment(''); setFilterStatus('all'); setActiveCard(null)
      selectFound(local)
      setScanInput('')
      return
    }
    // 待核销里没有：要么已经核销超过 24 小时，要么货还没出仓，要么单号不存在——分别告诉会计
    setScanSearching(true)
    try {
      const done = await apiGet<ReturnsResponse>(`/api/accounting/returns?tab=returned&q=${encodeURIComponent(code)}`)
      const hit = done.rows.find(r => r.code?.toUpperCase() === codeUpper)
      if (hit) {
        flash('warn', `${hit.code} 已于 ${hit.returnConfirmedAt ? new Date(hit.returnConfirmedAt).toLocaleString('en-GB') : '之前'} 核销（见「已核销」tab）`)
      } else {
        const list = await apiGet<Order[]>(`/api/orders?include_lines=false&colCode=${encodeURIComponent(code)}&limit=5`)
        const exact = (list ?? []).find(o => o.code?.toUpperCase() === codeUpper)
        if (exact) flash('warn', `${exact.code} 当前状态「${exact.status}」，货还没出仓，不在核销范围`)
        else flash('err', `找不到订单：${code}`, 3500)
      }
    } catch (err) {
      flash('err', err instanceof Error ? err.message : '查询失败', 3500)
    } finally {
      setScanSearching(false)
      setScanInput('')
    }
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else { next.add(id); markScanned([id]) }
      return next
    })
  }

  async function applyStatus(ids: string[], status: 'PENDING' | 'RETURNED' | 'ISSUE', note?: string, lines?: Array<{ orderLineId: string; deliveredQty: number }>) {
    if (ids.length === 0) return
    setBulkLoading(true)
    try {
      await apiPost('/api/orders/bulk', { ids, action: 'mark_returned', status, note, lines })
      setSelected(prev => { const next = new Set(prev); ids.forEach(id => next.delete(id)); return next })
      setIssueMode(null)
      setIssueNote('')
      setQtyEditRow(null)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败，请重试')
    } finally {
      setBulkLoading(false)
    }
  }

  async function generateInvoices(ids: string[]) {
    if (ids.length === 0) return
    setInvoiceLoading(true)
    try {
      const r = await apiPost<{
        total: number
        created: Array<{ code: string; invoiceId: string }>
        skipped: Array<{ code: string; reason: string }>
        failed: Array<{ code: string; error: string }>
      }>('/api/accounting/returns/bulk-invoice', { ids })
      const parts = [`成功生成 ${r.created.length} 张`]
      if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 张（已开过票/无可开票数量）`)
      if (r.failed.length) parts.push(`失败 ${r.failed.length} 张`)
      flash(r.failed.length ? 'warn' : 'ok', parts.join('，'), 6000)
    } catch (e) {
      alert(e instanceof Error ? e.message : '批量生成发票失败，请重试')
    } finally {
      setInvoiceLoading(false)
    }
  }

  function submitIssue() {
    const ids = issueMode === 'batch' ? [...selected] : issueMode ? [issueMode] : []
    if (!issueNote.trim()) return
    applyStatus(ids, 'ISSUE', issueNote.trim())
  }

  const visible = rows.filter(o => {
    if (scanInput.trim() && !o.code?.toUpperCase().includes(scanInput.trim().toUpperCase())
      && !o.restaurantName.toUpperCase().includes(scanInput.trim().toUpperCase())) return false
    if (filterDriver && (o.driver || '未分配') !== filterDriver) return false
    if (filterTime && o.timeOfDay !== filterTime) return false
    if (filterPayment && o.paymentMethod.toUpperCase() !== filterPayment) return false
    if (filterStatus !== 'all' && o.returnStatus !== filterStatus) return false
    if (activeCard === 'pendingConfirm' && !selected.has(o.id)) return false
    return true
  })

  const s = data?.summary
  const openCount = (s?.pending ?? 0) + (s?.issue ?? 0)

  function applyCardFilter(key: CardKey) {
    if (activeCard === key) { setActiveCard(null); setFilterStatus('all'); setFilterPayment(''); return }
    setActiveCard(key)
    setFilterPayment('')
    if (key === 'open') setFilterStatus('all')
    else if (key === 'returned') setFilterStatus('RETURNED')
    else if (key === 'issue') setFilterStatus('ISSUE')
    else if (key === 'pending') setFilterStatus('PENDING')
    else if (key === 'cashPending') { setFilterStatus('PENDING'); setFilterPayment('CASH') }
    else setFilterStatus('all')
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const withScan = useMemo(() => visible.map(o => ({ ...o, scanOrder: scanSeq[o.id] })), [visible, scanSeq])
  const sorted = sortRows(withScan, sortKey, sortDir)

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('asc') }
  }

  const selectableIds = sorted.filter(o => o.returnStatus === 'PENDING').map(o => o.id)
  const visibleSelectedCount = visible.filter(o => selected.has(o.id)).length
  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id))

  function openPrint() {
    const p = new URLSearchParams({ groupBy: printGroup })
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (filterDriver && filterDriver !== '未分配') p.set('driver', filterDriver)
    if (filterTime) p.set('timeOfDay', filterTime)
    if (filterPayment) p.set('payment', filterPayment)
    p.set('status', filterStatus === 'PENDING' || filterStatus === 'ISSUE' ? filterStatus : 'PENDING,ISSUE')
    // 服务端 PDF，与送货单 / 日报同一套打印模板（20261021 客户：打印要符合整体模板风格）
    openAuthedPdf(`/api/print/returns-pdf?${p}`).catch(e => alert(e instanceof Error ? e.message : '生成打印失败'))
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-6 gap-3">
        <StatCard label="未核销合计" value={openCount} sub={s ? `€${s.openAmount.toFixed(2)}${s.oldestDays ? ` · 最久 ${s.oldestDays} 天` : ''}` : undefined} urgent={openCount > 0} active={activeCard === 'open'} onClick={() => applyCardFilter('open')} testId="card-open" />
        <StatCard label="未回" value={s?.pending ?? 0} urgent={(s?.pending ?? 0) > 0} active={activeCard === 'pending'} onClick={() => applyCardFilter('pending')} testId="card-pending" />
        <StatCard label="有问题" value={s?.issue ?? 0} urgent={(s?.issue ?? 0) > 0} active={activeCard === 'issue'} onClick={() => applyCardFilter('issue')} />
        <StatCard label="待确认" value={selected.size} urgent={selected.size > 0} active={activeCard === 'pendingConfirm'} onClick={() => applyCardFilter('pendingConfirm')} />
        <StatCard label="24 小时内已核销" value={s?.returned ?? 0} active={activeCard === 'returned'} onClick={() => applyCardFilter('returned')} />
        <StatCard label="现金未核（€）" value={(s?.cashOpenAmount ?? 0).toFixed(2)} urgent={(s?.cashOpenAmount ?? 0) > 0} active={activeCard === 'cashPending'} onClick={() => applyCardFilter('cashPending')} />
      </div>

      {s && s.byDriver.length > 0 && (
        <div className="bg-white rounded border border-gray-200 shadow-sm px-5 py-3" data-testid="open-by-driver">
          <div className="text-xs font-semibold text-gray-600 mb-2">按司机：还没回来核销的单（点一下只看这位司机）</div>
          <div className="flex flex-wrap gap-2">
            {s.byDriver.map(d => (
              <button key={d.driver} onClick={() => { setFilterDriver(prev => prev === d.driver ? '' : d.driver); setActiveCard(null) }}
                className={`text-xs px-2.5 py-1.5 rounded border ${filterDriver === d.driver ? 'bg-purple-50' : 'bg-white hover:bg-gray-50'}`}
                style={filterDriver === d.driver ? { borderColor: ACCENT } : { borderColor: '#e5e7eb' }}>
                <span className="font-semibold text-gray-800">{d.driver}</span>
                <span className="ml-1.5 text-red-600 font-semibold">{d.count} 张</span>
                <span className="ml-1.5 text-gray-600">€{d.amount.toFixed(2)}</span>
                {d.cash > 0 && <span className="ml-1.5 text-red-500">现付 €{d.cash.toFixed(2)}</span>}
                {d.oldestDays > 0 && <span className="ml-1.5 text-amber-600">最久 {d.oldestDays} 天</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded border border-gray-200 shadow-sm px-5 py-4">
        <div className="text-sm font-semibold text-gray-700 mb-1">📷 扫码枪 / 输入单号</div>
        <div className="text-xs text-gray-400 mb-3">扫完整单号会把这一行标记「待确认」，还要再点「确认核销」才真正核销；只输入一部分会实时筛选下方列表（单号或客户）。下方列表是所有已出发、还没核销的单，不限日期</div>
        <form onSubmit={handleScan} className="flex gap-2">
          <input
            value={scanInput} onChange={e => setScanInput(e.target.value)}
            placeholder="扫描二维码或输入订单号"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            autoFocus data-testid="writeoff-scan"
          />
          <button type="submit" disabled={scanSearching} className="px-4 py-2 text-white rounded text-sm font-medium disabled:opacity-50" style={{ background: ACCENT }}>{scanSearching ? '查询中…' : '标记选中'}</button>
        </form>
        {scanMsg && (
          <div className={`mt-2 px-3 py-2 rounded text-sm font-medium ${scanMsg.type === 'ok' ? 'bg-green-50 text-green-700' : scanMsg.type === 'warn' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`} data-testid="writeoff-scan-msg">
            {scanMsg.text}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500">送货日期</span>
        <DatePicker value={from} onChange={setFrom} className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
        <span className="text-xs text-gray-400">至</span>
        <DatePicker value={to} onChange={setTo} className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
        {(from || to) && <button onClick={() => { setFrom(''); setTo('') }} className="text-xs text-gray-500 underline">全部日期</button>}
        <SearchableDropdown
          options={[{ value: '', label: '全部司机' }, ...[...(s?.drivers ?? []), ...(rows.some(r => !r.driver) ? ['未分配'] : [])].map(d => ({ value: d, label: d }))]}
          value={filterDriver} onChange={setFilterDriver}
        />
        <select value={filterTime} onChange={e => setFilterTime(e.target.value)} className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white">
          <option value="">上午 + 下午</option>
          <option value="am">上午</option>
          <option value="pm">下午</option>
        </select>
        <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)} className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white">
          <option value="">全部付款方式</option>
          <option value="CASH">现付</option>
          <option value="ONLINE">转账</option>
        </select>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value as typeof filterStatus); setActiveCard(null) }} className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white" data-testid="writeoff-status">
          <option value="all">全部回单状态</option>
          <option value="PENDING">仅未回</option>
          <option value="ISSUE">仅有问题</option>
          <option value="RETURNED">仅 24 小时内已核销</option>
        </select>
        <div className="flex items-center gap-1 ml-2">
          <select value={printGroup} onChange={e => setPrintGroup(e.target.value as 'date' | 'driver')} className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white" data-testid="print-group">
            <option value="date">按日期分组</option>
            <option value="driver">按司机分组</option>
          </select>
          <button onClick={openPrint} className="px-3 py-1.5 border rounded text-sm font-medium bg-white hover:bg-gray-50" style={{ borderColor: ACCENT, color: ACCENT }} data-testid="print-open">
            🖨 打印未核销清单
          </button>
        </div>

        {selected.size > 0 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-gray-600 font-medium">已选 {visibleSelectedCount} / {visible.length} 张</span>
            <button onClick={() => applyStatus([...selected], 'RETURNED')} disabled={bulkLoading} className="px-3 py-1.5 text-white rounded text-sm font-medium disabled:opacity-50" style={{ background: ACCENT }} data-testid="writeoff-confirm" title="批量确认核销按默认送达数量（全送）；如果某张单数量有差异，取消多选后单独点那一行的「核对数量」">
              {bulkLoading ? '处理中…' : '✅ 确认核销'}
            </button>
            <button onClick={() => setIssueMode('batch')} disabled={bulkLoading} className="px-3 py-1.5 rounded text-sm font-medium bg-amber-50 text-amber-700 disabled:opacity-50">❗ 退回核实</button>
            <button onClick={() => generateInvoices([...selected])} disabled={invoiceLoading} className="px-3 py-1.5 border rounded text-sm font-medium bg-white disabled:opacity-50" style={{ borderColor: ACCENT, color: ACCENT }} data-testid="writeoff-bulk-invoice" title="核销确认时已自动开票，这里只用于补开当时失败/遗漏的发票">
              {invoiceLoading ? '生成中…' : '🧾 补开漏开的发票'}
            </button>
            <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-500 bg-white">取消选择</button>
          </div>
        ) : (
          <span className="ml-auto text-xs text-gray-400">共 {visible.length} 条{today ? ` · 今天 ${today}` : ''}</span>
        )}
      </div>

      {issueMode && (
        <div className="flex gap-2 items-center px-4 py-3 bg-amber-50 border border-amber-200 rounded">
          <span className="text-sm font-medium text-amber-700 shrink-0">问题说明：</span>
          <input value={issueNote} onChange={e => setIssueNote(e.target.value)} placeholder="如：少了 2 箱 / 签收单字迹不清"
            className="flex-1 border border-amber-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" autoFocus />
          <button onClick={submitIssue} disabled={!issueNote.trim() || bulkLoading} className="px-3 py-1.5 rounded text-sm font-medium bg-amber-600 text-white disabled:opacity-50">确认退回</button>
          <button onClick={() => { setIssueMode(null); setIssueNote('') }} className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-500 bg-white">取消</button>
        </div>
      )}

      {loadError ? (
        <div className="text-center py-16 text-red-500">{loadError}</div>
      ) : loading && !data ? (
        <div className="text-center py-16 text-gray-400">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-green-600">✅ 所有已出发的单都已核销{from || to ? '（当前日期范围内）' : ''}</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">没有匹配的订单（共 {rows.length} 张待核销，被筛选条件挡住了）</div>
      ) : (
        <div ref={tableRef} className="bg-white rounded border border-gray-200 shadow-sm overflow-x-auto scroll-mt-6">
          <table className="w-full text-sm" data-testid="writeoff-table">
            <thead className="bg-gray-50 border-b text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2.5 text-center w-8">
                  <input type="checkbox" checked={allVisibleSelected}
                    onChange={() => setSelected(prev => {
                      const allSel = selectableIds.every(id => prev.has(id))
                      const next = new Set(prev)
                      if (allSel) selectableIds.forEach(id => next.delete(id))
                      else { markScanned(selectableIds); selectableIds.forEach(id => next.add(id)) }
                      return next
                    })}
                    style={{ accentColor: ACCENT }} />
                </th>
                <SortTh label="扫描顺序" sk="scanOrder" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="送货日期" sk="deliveryDate" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="订单号" sk="code" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="客户" sk="restaurantName" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="上午/下午" sk="timeOfDay" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <SortTh label="司机" sk="driver" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="含税金额" sk="amount" cur={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortTh label="付款方式" sk="paymentMethod" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <SortTh label="已送出" sk="daysOut" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <SortTh label="状态" sk="returnStatus" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <th className="px-4 py-2.5 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(o => (
                <WriteOffRow
                  key={o.id} row={o}
                  isSelected={selected.has(o.id)} isFlashing={flashId === o.id}
                  scanOrder={scanSeq[o.id]}
                  rowRef={el => { rowRefs.current[o.id] = el }}
                  onToggle={() => toggle(o.id)}
                  onConfirm={() => applyStatus([o.id], 'RETURNED')}
                  onReturn={() => setIssueMode(o.id)}
                  onReset={() => applyStatus([o.id], 'PENDING')}
                  onEditQty={() => setQtyEditRow(o)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {qtyEditRow && (
        <QtyEditDialog
          row={qtyEditRow}
          busy={bulkLoading}
          onCancel={() => setQtyEditRow(null)}
          onConfirm={lines => applyStatus([qtyEditRow.id], 'RETURNED', undefined, lines)}
        />
      )}

      {(s?.pending ?? 0) > 0 && (
        <div className="bg-red-50 border border-red-200 rounded px-5 py-4">
          <div className="font-semibold text-red-700 mb-1">⚠️ 共有 {s!.pending} 张已送出的单还没回来核销{s!.oldestDays > 0 ? `，最久的已送出 ${s!.oldestDays} 天` : ''}</div>
          <div className="text-sm text-red-600">请联系对应司机追回签收单，可打印清单交给司机。现付漏单风险最高，优先处理现付订单。</div>
        </div>
      )}
    </div>
  )
}

function WriteOffRow({ row: o, isSelected, isFlashing, scanOrder, rowRef, onToggle, onConfirm, onReturn, onReset, onEditQty }: {
  row: ReturnRow
  isSelected: boolean
  isFlashing: boolean
  scanOrder: number | undefined
  rowRef: (el: HTMLTableRowElement | null) => void
  onToggle: () => void
  onConfirm: () => void
  onReturn: () => void
  onReset: () => void
  onEditQty: () => void
}) {
  const status = o.returnStatus
  const cash = isCash(o)
  let rowBg = ''
  if (isFlashing) rowBg = 'bg-purple-50 transition-colors duration-500'
  else if (isSelected) rowBg = 'bg-purple-50/50'
  else if (status === 'ISSUE') rowBg = 'bg-amber-50'
  else if (status === 'PENDING' && cash) rowBg = 'bg-red-50'
  else if (status === 'PENDING') rowBg = 'bg-yellow-50'

  return (
    <tr ref={rowRef} className={`hover:bg-gray-50 transition-colors ${rowBg}`} data-testid={`writeoff-row-${o.code}`}>
      <td className="px-3 py-2.5 text-center">
        <input type="checkbox" checked={isSelected} onChange={onToggle} disabled={status !== 'PENDING'}
          style={{ accentColor: ACCENT }} className="disabled:opacity-40 disabled:cursor-not-allowed" />
      </td>
      <td className="px-4 py-2.5 text-gray-500 text-xs">{scanOrder != null ? `#${scanOrder}` : <span className="text-gray-300">—</span>}</td>
      <td className="px-4 py-2.5 text-gray-700 text-xs whitespace-nowrap">{o.deliveryDate ?? '—'}</td>
      <td className="px-4 py-2.5 font-mono text-xs text-gray-700 whitespace-nowrap">{o.code ?? o.id.slice(-8)}</td>
      <td className="px-4 py-2.5 text-gray-800 max-w-[160px] truncate" title={o.restaurantName}>{o.restaurantName}</td>
      <td className="px-4 py-2.5 text-center text-xs text-gray-600">{TIME_TEXT[o.timeOfDay] ?? <span className="text-gray-300">—</span>}</td>
      <td className="px-4 py-2.5 text-gray-700">{o.driver || <span className="text-gray-300">未分配</span>}</td>
      <td className="px-4 py-2.5 text-right font-semibold text-gray-800">€{o.amount.toFixed(2)}</td>
      <td className="px-4 py-2.5 text-center">
        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{cash ? '现付' : '转账'}</span>
      </td>
      <td className={`px-4 py-2.5 text-center text-xs ${status !== 'RETURNED' && o.daysOut >= 2 ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
        {status === 'RETURNED' ? '—' : o.daysOut === 0 ? '今天' : `${o.daysOut} 天`}
      </td>
      <td className="px-4 py-2.5 text-center">
        {status === 'RETURNED' && (
          <div>
            <span className="text-green-600 font-semibold text-xs">✅ 已核销</span>
            {o.returnConfirmedAt && <div className="text-[10px] text-gray-400 mt-0.5">{new Date(o.returnConfirmedAt).toLocaleString('en-GB')}{o.returnConfirmedBy ? ` · ${o.returnConfirmedBy}` : ''}</div>}
          </div>
        )}
        {status === 'ISSUE' && (
          <div>
            <span className="text-amber-600 font-semibold text-xs">❗ 有问题</span>
            {o.returnIssueNote && <div className="text-[11px] text-amber-600 mt-0.5">{o.returnIssueNote}</div>}
          </div>
        )}
        {status === 'PENDING' && <span className="text-red-500 font-semibold text-xs">⚠️ 未回</span>}
      </td>
      <td className="px-4 py-2.5 text-center">
        {status === 'RETURNED' && <button onClick={onReset} className="text-xs text-gray-400 hover:text-red-500 underline">撤销</button>}
        {status === 'ISSUE' && <button onClick={onReset} className="text-xs text-gray-400 hover:text-purple-600 underline">重新核对</button>}
        {status === 'PENDING' && isSelected && (
          <div className="flex gap-1 justify-center">
            <button onClick={onConfirm} className="px-2 py-1 text-white text-xs rounded font-medium" style={{ background: ACCENT }}>确认核销</button>
            <button onClick={onEditQty} className="px-2 py-1 text-xs rounded font-medium border" style={{ borderColor: ACCENT, color: ACCENT }} title="数量跟实际送达的不一样？打开核对，改过的数量按改过的开票">核对数量</button>
            <button onClick={onReturn} className="px-2 py-1 text-xs rounded font-medium bg-amber-50 text-amber-700">退回</button>
          </div>
        )}
        {status === 'PENDING' && !isSelected && <span className="text-gray-300 text-xs">扫码后可操作</span>}
      </td>
    </tr>
  )
}

/**
 * 核销弹窗「核对数量」—— 20261026。默认按下单量全送（后端已经这么写了），
 * 这里只在真的有差异（少送/缺货/客户拒收部分）时才需要改；改完点「确认核销」
 * 带着改过的 deliveredQty 一起提交，开票/提成就按改过的算，不是先核对完再核销两步走。
 */
function QtyEditDialog({ row, busy, onCancel, onConfirm }: {
  row: ReturnRow
  busy: boolean
  onCancel: () => void
  onConfirm: (lines: Array<{ orderLineId: string; deliveredQty: number }>) => void
}) {
  const [lines, setLines] = useState<ReturnOrderLineRow[] | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiGet<{ lines: ReturnOrderLineRow[] }>(`/api/accounting/returns/${row.id}/lines`)
      .then(r => { if (!cancelled) setLines(r.lines) })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : '加载订单行失败') })
    return () => { cancelled = true }
  }, [row.id])

  function setQty(lineId: string, v: string) {
    const n = Number(v)
    setLines(prev => prev?.map(l => l.id === lineId ? { ...l, deliveredQty: Number.isFinite(n) && n >= 0 ? n : l.deliveredQty } : l) ?? prev)
  }

  const hasDiff = lines?.some(l => l.deliveredQty !== l.orderedQty) ?? false

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={onCancel}>
      <div className="bg-white rounded shadow-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <div className="font-semibold text-gray-800">核对送达数量 · {row.code ?? row.id.slice(-8)}</div>
            <div className="text-xs text-gray-500 mt-0.5">{row.restaurantName}</div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-5 py-4">
          {loadError ? (
            <div className="text-red-500 text-sm py-6 text-center">{loadError}</div>
          ) : !lines ? (
            <div className="text-gray-400 text-sm py-6 text-center">加载中…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b">
                <tr>
                  <th className="text-left py-2">商品</th>
                  <th className="text-center py-2 w-20">单位</th>
                  <th className="text-right py-2 w-24">下单数量</th>
                  <th className="text-right py-2 w-28">实际送达</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map(l => (
                  <tr key={l.id} className={l.deliveredQty !== l.orderedQty ? 'bg-amber-50' : ''}>
                    <td className="py-2 text-gray-800">
                      {l.productName}
                      {l.isGift && <span className="ml-1.5 text-[10px] text-green-600">赠品</span>}
                      {l.spec && <div className="text-[11px] text-gray-400">{l.spec}</div>}
                    </td>
                    <td className="py-2 text-center text-gray-600">{l.uomName ?? '—'}</td>
                    <td className="py-2 text-right text-gray-600">{l.orderedQty}</td>
                    <td className="py-2 text-right">
                      <input
                        type="number" min={0} step="0.001" value={l.deliveredQty}
                        onChange={e => setQty(l.id, e.target.value)}
                        className="w-24 text-right border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                        style={l.deliveredQty !== l.orderedQty ? { borderColor: ACCENT } : {}}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <span className="text-xs text-gray-400">{hasDiff ? '有行改过数量，开票/提成会按改过的算' : '没有改动，按下单量全送核销'}</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-500 bg-white">取消</button>
            <button
              onClick={() => lines && onConfirm(lines.map(l => ({ orderLineId: l.id, deliveredQty: l.deliveredQty })))}
              disabled={!lines || busy}
              className="px-3 py-1.5 text-white rounded text-sm font-medium disabled:opacity-50"
              style={{ background: ACCENT }}
            >
              {busy ? '处理中…' : '✅ 确认核销'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const RETURNED_PAGE_SIZE = 50

/** 「已核销」tab：全部已核销的单，按送货日期 / 司机筛选、按单号或客户搜索（20261021） */
function ReturnedList() {
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
  const [to, setTo] = useState('')
  const [driver, setDriver] = useState('')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [data, setData] = useState<ReturnsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 400); return () => clearTimeout(t) }, [q])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ tab: 'returned' })
      if (from) p.set('from', from)
      if (to) p.set('to', to)
      if (driver) p.set('driver', driver)
      if (debouncedQ) p.set('q', debouncedQ)
      setData(await apiGet<ReturnsResponse>(`/api/accounting/returns?${p}`))
      setPage(1)
    } finally {
      setLoading(false)
    }
  }, [from, to, driver, debouncedQ])

  useEffect(() => { load() }, [load])

  async function undo(r: ReturnRow) {
    if (!confirm(`撤销 ${r.code} 的核销？它会回到「待核销」的未回状态。`)) return
    setBusyId(r.id)
    try {
      await apiPost('/api/orders/bulk', { ids: [r.id], action: 'mark_returned', status: 'PENDING' })
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '撤销失败')
    } finally {
      setBusyId(null)
    }
  }

  const rows = [...(data?.rows ?? [])].sort((a, b) => (b.returnConfirmedAt ?? '').localeCompare(a.returnConfirmedAt ?? ''))
  const pageRows = rows.slice((page - 1) * RETURNED_PAGE_SIZE, page * RETURNED_PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(rows.length / RETURNED_PAGE_SIZE))
  const total = rows.reduce((s, r) => s + r.amount, 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500">送货日期</span>
        <DatePicker value={from} onChange={setFrom} className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
        <span className="text-xs text-gray-400">至</span>
        <DatePicker value={to} onChange={setTo} className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" />
        <SearchableDropdown
          options={[{ value: '', label: '全部司机' }, ...(data?.summary.drivers ?? []).map(d => ({ value: d, label: d }))]}
          value={driver} onChange={setDriver}
        />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索单号 / 客户"
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-56" data-testid="returned-search" />
        <span className="ml-auto text-xs text-gray-400">{loading ? '加载中…' : `共 ${rows.length} 张已核销 · €${total.toFixed(2)}`}</span>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-16 text-gray-400">{loading ? '加载中…' : '这段时间没有已核销的单'}</div>
      ) : (
        <div className="bg-white rounded border border-gray-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm" data-testid="returned-table">
            <thead className="bg-gray-50 border-b text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2.5 text-left">送货日期</th>
                <th className="px-4 py-2.5 text-left">订单号</th>
                <th className="px-4 py-2.5 text-left">客户</th>
                <th className="px-4 py-2.5 text-center">上午/下午</th>
                <th className="px-4 py-2.5 text-left">司机</th>
                <th className="px-4 py-2.5 text-right">含税金额</th>
                <th className="px-4 py-2.5 text-center">付款方式</th>
                <th className="px-4 py-2.5 text-left">核销时间</th>
                <th className="px-4 py-2.5 text-left">核销人</th>
                <th className="px-4 py-2.5 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pageRows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-xs text-gray-700 whitespace-nowrap">{r.deliveryDate ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700 whitespace-nowrap">{r.code ?? r.id.slice(-8)}</td>
                  <td className="px-4 py-2 text-gray-800 max-w-[180px] truncate" title={r.restaurantName}>{r.restaurantName}</td>
                  <td className="px-4 py-2 text-center text-xs text-gray-600">{TIME_TEXT[r.timeOfDay] ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-700">{r.driver || '—'}</td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">€{r.amount.toFixed(2)}</td>
                  <td className="px-4 py-2 text-center text-xs">{isCash(r) ? '现付' : '转账'}</td>
                  <td className="px-4 py-2 text-xs text-gray-600 whitespace-nowrap">{r.returnConfirmedAt ? new Date(r.returnConfirmedAt).toLocaleString('en-GB') : '—'}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{r.returnConfirmedBy ?? '—'}</td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => undo(r)} disabled={busyId === r.id} className="text-xs text-gray-400 hover:text-red-500 underline disabled:opacity-50">撤销</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 px-4 py-2 border-t text-xs text-gray-600">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">‹</button>
              <span>{page} / {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">›</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, urgent, active, onClick, testId }: { label: string; value: number | string; sub?: string; urgent?: boolean; active?: boolean; onClick?: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className={`text-left w-full rounded border px-4 py-3 transition-all bg-white ${active ? 'shadow-md' : 'border-gray-200 hover:shadow-md hover:border-gray-300'}`}
      style={active ? { borderColor: ACCENT, boxShadow: '0 0 0 2px #e8d5f0' } : {}}>
      <div className="text-xs font-medium text-gray-500 flex items-center gap-1">{label}<span className="text-[10px] opacity-60">{active ? '●' : '›'}</span></div>
      <div className="text-2xl font-bold mt-1" style={{ color: urgent ? '#dc2626' : active ? ACCENT : '#1f2937' }}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </button>
  )
}
