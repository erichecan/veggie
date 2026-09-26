'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { SearchableDropdown } from '@/components/shared/searchable-dropdown'
import { SortTh, sortRows, type SortDir } from '@/components/shared/sort-th'

const ACCENT = '#875A7B'

type SortKey = 'code' | 'deliveryDate' | 'restaurantName' | 'deliveryBatch' | 'totalAmount' | 'paymentMethod' | 'status' | 'returnStatus' | 'scanOrder'
type CardKey = 'all' | 'returned' | 'issue' | 'pending' | 'cashPending' | 'pendingConfirm'

function incTaxAmount(o: Order): number {
  return o.totalAmountIncTax ?? o.totalAmount ?? 0
}

/**
 * 会计核销页「单」板块：扫码枪比对今日所有送出去的单，两步核销——
 * 扫中先标记「待确认」，会计再点一次「确认核销」才真正落库；单据有问题
 * 就点「退回核实」并写明原因，落成「有问题」第三态，不是简单的回/没回。
 */
export function WriteOffBoard({ businessDate }: { businessDate: string | null }) {
  const [orders, setOrders] = useState<Order[]>([])
  // 扫到的单不在今天的默认加载范围内时（比如司机昨天忘了回单，今天才来核销）落在这里，
  // 跟 orders 分开存：这样 load() 重新拉今天的数据时不会把它们冲掉（20260925 用户反馈：
  // 只能扫今天的单不合理）
  const [extraOrders, setExtraOrders] = useState<Order[]>([])
  const [scanSearching, setScanSearching] = useState(false)
  // 初始 false：businessDate 来自「钱」板块的回调，若那次请求失败会永远不回调，
  // 这里若默认 true 会在没有 businessDate 时永远卡在「加载中」（20260924 code-review 发现）
  const [loading, setLoading] = useState(false)
  const [filterBatch, setFilterBatch] = useState('')
  const [filterPayment, setFilterPayment] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'PENDING' | 'RETURNED' | 'ISSUE'>('all')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const [scanMsg, setScanMsg] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('deliveryBatch')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [flashId, setFlashId] = useState<string | null>(null)
  const [activeCard, setActiveCard] = useState<CardKey | null>(null)
  const [issueMode, setIssueMode] = useState<'batch' | string | null>(null)
  const [issueNote, setIssueNote] = useState('')
  const scanSeqCounter = useRef(0)
  const [scanSeq, setScanSeq] = useState<Record<string, number>>({})
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const tableRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!businessDate) return
    setLoading(true)
    try {
      const data = await apiGet<Order[]>(
        `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,COMPLETED,IN_DELIVERY&include_lines=false&deliveryFrom=${businessDate}&deliveryTo=${businessDate}&limit=5000`,
      )
      setOrders(data ?? [])
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [businessDate])

  useEffect(() => { load() }, [load])

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

  function selectFoundOrder(target: Order, prefixMsg?: string) {
    if (target.returnStatus === 'RETURNED') {
      setScanMsg({ type: 'warn', text: `${target.code} 已经核销过了` })
    } else if (target.returnStatus === 'ISSUE') {
      setScanMsg({ type: 'warn', text: `${target.code} 之前标记了「有问题」，点下方「重新核对」` })
    } else {
      setSelected(prev => new Set(prev).add(target.id))
      markScanned([target.id])
      setScanMsg({ type: 'ok', text: `${prefixMsg ?? ''}✅ ${target.code} 已标记待确认` })
    }
    flashRow(target.id)
    setTimeout(() => setScanMsg(null), 4500)
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault()
    const code = scanInput.trim()
    if (!code) return
    const codeUpper = code.toUpperCase()
    const local = todayOrders.find(o => o.code?.toUpperCase() === codeUpper) ?? (visible.length === 1 ? visible[0] : undefined)
    if (local) {
      selectFoundOrder(local)
      setScanInput('')
      return
    }
    // 本地（今天）没找到——服务端按单号跨日期查一次，覆盖"司机昨天忘了回单，今天才来核销"
    // 这种场景（不能只让核销卡死在"今天"这个范围里）
    setScanSearching(true)
    let keepInput = false
    try {
      const results = await apiGet<Order[]>(
        `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,COMPLETED,IN_DELIVERY&include_lines=false&colCode=${encodeURIComponent(code)}&limit=20`,
      )
      const list = results ?? []
      const exact = list.filter(o => o.code?.toUpperCase() === codeUpper)
      // 只输入一部分（比如 "mj"）时 exact 恒为空，但服务端 contains 搜索可能真的搜到了单——
      // 之前只认 exact，搜到多条也一律回「找不到」，误导用户以为单不存在（20260926 用户反馈）
      const candidates = exact.length > 0 ? exact : list
      if (candidates.length === 1) {
        const target = candidates[0]
        const isExact = target.code?.toUpperCase() === codeUpper
        setExtraOrders(prev => prev.some(o => o.id === target.id) ? prev : [...prev, target])
        const day = target.deliveryDate ? target.deliveryDate.slice(0, 10) : '未知日期'
        selectFoundOrder(target, isExact
          ? `⚠️ 不是今天的单（送货日期 ${day}），已补进下方列表——`
          : `⚠️ 按「${code}」模糊匹配到唯一一条（${target.code}，送货日期 ${day}），已补进下方列表——`)
      } else if (candidates.length > 1) {
        // 名副其实的"模糊搜索"：不能只甩一句话让用户自己去翻别的面板核对，
        // 而是把匹配到的这些单直接补进列表——scanInput 保留不清空，下面表格的
        // 实时筛选（第 173 行左右）会自己把范围收窄到这几条，用户直接点选正确的一条
        // （20260926 用户反馈：之前只提示"到下方核对"其实没把结果摆出来，等于没做）
        setExtraOrders(prev => {
          const known = new Set(prev.map(o => o.id))
          const additions = candidates.filter(o => !known.has(o.id))
          return additions.length > 0 ? [...prev, ...additions] : prev
        })
        keepInput = true
        setScanMsg({ type: 'warn', text: `按「${code}」模糊匹配到 ${candidates.length} 条，已列在下方，请点选正确的一条` })
        setTimeout(() => setScanMsg(null), 5000)
        setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      } else {
        setScanMsg({ type: 'err', text: `找不到订单：${code}` })
        setTimeout(() => setScanMsg(null), 3500)
      }
    } finally {
      setScanSearching(false)
    }
    if (!keepInput) setScanInput('')
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else { next.add(id); markScanned([id]) }
      return next
    })
  }

  async function applyStatus(ids: string[], status: 'PENDING' | 'RETURNED' | 'ISSUE', note?: string) {
    if (ids.length === 0) return
    setBulkLoading(true)
    try {
      await apiPost('/api/orders/bulk', { ids, action: 'mark_returned', status, note })
      const patch = (o: Order) => ids.includes(o.id) ? { ...o, returnStatus: status, returnIssueNote: status === 'ISSUE' ? (note ?? null) : null } : o
      setOrders(prev => prev.map(patch))
      // extraOrders 是扫码跨日期补进来的单，applyStatus 后端写库不区分来源，这里也要同步更新，
      // 否则跨日期核销的单会出现"数据库已改、界面没跟着变"的假象（20260925 实测踩过一次）
      setExtraOrders(prev => prev.map(patch))
      setSelected(prev => { const next = new Set(prev); ids.forEach(id => next.delete(id)); return next })
      setIssueMode(null)
      setIssueNote('')
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败，请重试')
    } finally {
      setBulkLoading(false)
    }
  }

  function submitIssue() {
    const ids = issueMode === 'batch' ? [...selected] : issueMode ? [issueMode] : []
    if (!issueNote.trim()) return
    applyStatus(ids, 'ISSUE', issueNote.trim())
  }

  // orders 是服务端按 businessDate 精确过滤的结果；extraOrders 是扫码补进来的跨日期单
  const todayOrders = extraOrders.length > 0 ? [...orders, ...extraOrders] : orders
  const visible = todayOrders.filter(o => {
    if (scanInput.trim() && !o.code?.toUpperCase().includes(scanInput.trim().toUpperCase())) return false
    if (filterBatch && !formatDriverSlotFromOrder(o).toLowerCase().includes(filterBatch.toLowerCase())) return false
    if (filterPayment && String(o.paymentMethod).toUpperCase() !== filterPayment) return false
    if (filterStatus !== 'all' && (o.returnStatus ?? 'PENDING') !== filterStatus) return false
    if (activeCard === 'pendingConfirm' && !selected.has(o.id)) return false
    return true
  })

  const totalOrders = todayOrders.length
  const returnedCount = todayOrders.filter(o => o.returnStatus === 'RETURNED').length
  const issueCount = todayOrders.filter(o => o.returnStatus === 'ISSUE').length
  const pendingCount = totalOrders - returnedCount - issueCount
  const pendingConfirmCount = selected.size
  const cashPending = todayOrders.filter(o => o.returnStatus !== 'RETURNED' && String(o.paymentMethod).toUpperCase() === 'CASH')
    .reduce((s, o) => s + incTaxAmount(o), 0)

  function applyCardFilter(key: CardKey) {
    if (activeCard === key) { setActiveCard(null); setFilterStatus('all'); setFilterPayment(''); return }
    setActiveCard(key)
    if (key === 'all') { setFilterStatus('all'); setFilterPayment('') }
    else if (key === 'returned') { setFilterStatus('RETURNED'); setFilterPayment('') }
    else if (key === 'issue') { setFilterStatus('ISSUE'); setFilterPayment('') }
    else if (key === 'pending') { setFilterStatus('PENDING'); setFilterPayment('') }
    else if (key === 'cashPending') { setFilterStatus('PENDING'); setFilterPayment('CASH') }
    else if (key === 'pendingConfirm') { setFilterStatus('all'); setFilterPayment('') }
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const withAmountSort = useMemo(() => visible.map(o => ({ ...o, _amount: incTaxAmount(o), _scanOrder: scanSeq[o.id] })), [visible, scanSeq])
  const sortField = sortKey === 'totalAmount' ? '_amount' : sortKey === 'scanOrder' ? '_scanOrder' : sortKey
  const sorted = sortRows(withAmountSort, sortField, sortDir)

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('asc') }
  }

  const selectableIds = sorted.filter(o => (o.returnStatus ?? 'PENDING') === 'PENDING').map(o => o.id)
  const visibleSelectedCount = visible.filter(o => selected.has(o.id)).length
  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-6 gap-3">
        <StatCard label="今日总单" value={totalOrders} active={activeCard === 'all'} onClick={() => applyCardFilter('all')} />
        <StatCard label="已核销" value={returnedCount} active={activeCard === 'returned'} onClick={() => applyCardFilter('returned')} />
        <StatCard label="待确认" value={pendingConfirmCount} urgent={pendingConfirmCount > 0} active={activeCard === 'pendingConfirm'} onClick={() => applyCardFilter('pendingConfirm')} />
        <StatCard label="有问题" value={issueCount} urgent={issueCount > 0} active={activeCard === 'issue'} onClick={() => applyCardFilter('issue')} />
        <StatCard label="未回" value={pendingCount} urgent={pendingCount > 0} active={activeCard === 'pending'} onClick={() => applyCardFilter('pending')} />
        <StatCard label="现金未核（€）" value={cashPending.toFixed(2)} urgent={cashPending > 0} active={activeCard === 'cashPending'} onClick={() => applyCardFilter('cashPending')} />
      </div>

      <div className="bg-white rounded border border-gray-200 shadow-sm px-5 py-4">
        <div className="text-sm font-semibold text-gray-700 mb-1">📷 扫码枪 / 输入单号</div>
        <div className="text-xs text-gray-400 mb-3">扫完整单号会把这一行标记「待确认」，还要再点「确认核销」才真正核销；只输入一部分会实时筛选下方列表；今天列表里没有的单号会自动按单号跨日期查一次（司机昨天忘了回单也能在这里核销）</div>
        <form onSubmit={handleScan} className="flex gap-2">
          <input
            value={scanInput} onChange={e => setScanInput(e.target.value)}
            placeholder="扫描二维码或输入订单号"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            autoFocus
          />
          <button type="submit" disabled={scanSearching} className="px-4 py-2 text-white rounded text-sm font-medium disabled:opacity-50" style={{ background: ACCENT }}>{scanSearching ? '查询中…' : '标记选中'}</button>
        </form>
        {scanMsg && (
          <div className={`mt-2 px-3 py-2 rounded text-sm font-medium ${scanMsg.type === 'ok' ? 'bg-green-50 text-green-700' : scanMsg.type === 'warn' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`}>
            {scanMsg.text}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <SearchableDropdown
          options={[{ value: '', label: '全部批次/司机' }, ...[...new Set(todayOrders.map(o => formatDriverSlotFromOrder(o)).filter(Boolean))].map(b => ({ value: b, label: b }))]}
          value={filterBatch} onChange={setFilterBatch}
        />
        <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)} className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white">
          <option value="">全部付款方式</option>
          <option value="CASH">现付</option>
          <option value="ONLINE">转账</option>
        </select>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value as typeof filterStatus); setActiveCard(null) }} className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white">
          <option value="all">全部回单状态</option>
          <option value="RETURNED">仅已核销</option>
          <option value="ISSUE">仅有问题</option>
          <option value="PENDING">仅未回</option>
        </select>

        {selected.size > 0 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-gray-600 font-medium">已选 {visibleSelectedCount} / {visible.length} 张</span>
            <button onClick={() => applyStatus([...selected], 'RETURNED')} disabled={bulkLoading} className="px-3 py-1.5 text-white rounded text-sm font-medium disabled:opacity-50" style={{ background: ACCENT }}>
              {bulkLoading ? '处理中…' : '✅ 确认核销'}
            </button>
            <button onClick={() => setIssueMode('batch')} disabled={bulkLoading} className="px-3 py-1.5 rounded text-sm font-medium bg-amber-50 text-amber-700 disabled:opacity-50">❗ 退回核实</button>
            <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-500 bg-white">取消选择</button>
          </div>
        ) : (
          <span className="ml-auto text-xs text-gray-400">共 {visible.length} 条 · {businessDate}</span>
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

      {!businessDate ? (
        <div className="text-center py-16 text-gray-400">等待「钱」板块加载日期…（若一直不出现，请检查上方是否报错）</div>
      ) : loading ? (
        <div className="text-center py-16 text-gray-400">加载中…</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">没有匹配的订单</div>
      ) : (
        <div ref={tableRef} className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden scroll-mt-6">
          <table className="w-full text-sm">
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
                <SortTh label="订单号" sk="code" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="客户" sk="restaurantName" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="批次/司机" sk="deliveryBatch" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" />
                <SortTh label="含税金额" sk="totalAmount" cur={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortTh label="付款方式" sk="paymentMethod" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <SortTh label="状态" sk="returnStatus" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" />
                <th className="px-4 py-2.5 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(o => (
                <WriteOffRow
                  key={o.id} order={o} businessDate={businessDate}
                  isSelected={selected.has(o.id)} isFlashing={flashId === o.id}
                  scanOrder={scanSeq[o.id]}
                  rowRef={el => { rowRefs.current[o.id] = el }}
                  onToggle={() => toggle(o.id)}
                  onConfirm={() => applyStatus([o.id], 'RETURNED')}
                  onReturn={() => setIssueMode(o.id)}
                  onUndo={() => applyStatus([o.id], 'PENDING')}
                  onReopen={() => applyStatus([o.id], 'PENDING')}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded px-5 py-4">
          <div className="font-semibold text-red-700 mb-1">⚠️ 今日共有 {pendingCount} 张送货单未回</div>
          <div className="text-sm text-red-600">请立即联系对应司机追查签收单。现付漏单风险最高，优先处理现付订单。</div>
        </div>
      )}
    </div>
  )
}

function WriteOffRow({ order: o, businessDate, isSelected, isFlashing, scanOrder, rowRef, onToggle, onConfirm, onReturn, onUndo, onReopen }: {
  order: Order
  businessDate: string | null
  isSelected: boolean
  isFlashing: boolean
  scanOrder: number | undefined
  rowRef: (el: HTMLTableRowElement | null) => void
  onToggle: () => void
  onConfirm: () => void
  onReturn: () => void
  onUndo: () => void
  onReopen: () => void
}) {
  const status = o.returnStatus ?? 'PENDING'
  const orderDay = o.deliveryDate ? o.deliveryDate.slice(0, 10) : null
  const isOtherDay = !!orderDay && !!businessDate && orderDay !== businessDate
  const isCash = String(o.paymentMethod).toUpperCase() === 'CASH'
  let rowBg = ''
  if (isFlashing) rowBg = 'bg-purple-50 transition-colors duration-500'
  else if (isSelected) rowBg = 'bg-purple-50/50'
  else if (status === 'ISSUE') rowBg = 'bg-amber-50'
  else if (status === 'PENDING' && isCash) rowBg = 'bg-red-50'
  else if (status === 'PENDING') rowBg = 'bg-yellow-50'

  return (
    <tr ref={rowRef} className={`hover:bg-gray-50 transition-colors ${rowBg}`}>
      <td className="px-3 py-2.5 text-center">
        <input type="checkbox" checked={isSelected} onChange={onToggle} disabled={status !== 'PENDING'}
          style={{ accentColor: ACCENT }} className="disabled:opacity-40 disabled:cursor-not-allowed" />
      </td>
      <td className="px-4 py-2.5 text-gray-500 text-xs">{scanOrder != null ? `#${scanOrder}` : <span className="text-gray-300">—</span>}</td>
      <td className="px-4 py-2.5 font-mono text-xs text-gray-700">
        {o.code ?? o.id.slice(-8)}
        {isOtherDay && <div className="font-sans text-[10px] text-amber-600 mt-0.5">⚠️ {orderDay}</div>}
      </td>
      <td className="px-4 py-2.5 text-gray-800 max-w-[140px] truncate">{o.restaurantName}</td>
      <td className="px-4 py-2.5 text-gray-600">{formatDriverSlotFromOrder(o) || <span className="text-gray-300">未分配</span>}</td>
      <td className="px-4 py-2.5 text-right font-semibold text-gray-800">€{incTaxAmount(o).toFixed(2)}</td>
      <td className="px-4 py-2.5 text-center">
        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{isCash ? '现付' : '转账'}</span>
      </td>
      <td className="px-4 py-2.5 text-center">
        {status === 'RETURNED' && <span className="text-green-600 font-semibold text-xs">✅ 已核销</span>}
        {status === 'ISSUE' && (
          <div>
            <span className="text-amber-600 font-semibold text-xs">❗ 有问题</span>
            {o.returnIssueNote && <div className="text-[11px] text-amber-600 mt-0.5">{o.returnIssueNote}</div>}
          </div>
        )}
        {status === 'PENDING' && <span className="text-red-500 font-semibold text-xs animate-pulse">⚠️ 未回</span>}
      </td>
      <td className="px-4 py-2.5 text-center">
        {status === 'RETURNED' && <button onClick={onUndo} className="text-xs text-gray-400 hover:text-red-500 underline">撤销</button>}
        {status === 'ISSUE' && <button onClick={onReopen} className="text-xs text-gray-400 hover:text-purple-600 underline">重新核对</button>}
        {status === 'PENDING' && isSelected && (
          <div className="flex gap-1 justify-center">
            <button onClick={onConfirm} className="px-2 py-1 text-white text-xs rounded font-medium" style={{ background: ACCENT }}>确认核销</button>
            <button onClick={onReturn} className="px-2 py-1 text-xs rounded font-medium bg-amber-50 text-amber-700">退回</button>
          </div>
        )}
        {status === 'PENDING' && !isSelected && <span className="text-gray-300 text-xs">扫码后可操作</span>}
      </td>
    </tr>
  )
}

function StatCard({ label, value, urgent, active, onClick }: { label: string; value: number | string; urgent?: boolean; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-left w-full rounded border px-4 py-3 transition-all bg-white ${active ? 'shadow-md' : 'border-gray-200 hover:shadow-md hover:border-gray-300'}`}
      style={active ? { borderColor: ACCENT, boxShadow: '0 0 0 2px #e8d5f0' } : {}}>
      <div className="text-xs font-medium text-gray-500 flex items-center gap-1">{label}<span className="text-[10px] opacity-60">{active ? '●' : '›'}</span></div>
      <div className="text-2xl font-bold mt-1" style={{ color: urgent ? '#dc2626' : active ? ACCENT : '#1f2937' }}>{value}</div>
    </button>
  )
}
