'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import type { Order, OrderLine } from '@/lib/types'
import { fetchDispatchPrintHtml, buildDispatchSummaryPdfUrl, buildDispatchPickingPdfUrl } from '@/lib/print/dispatch-print-html'
import { type PrintContentFilter, applyPrintContentFilter, hasContentFilter } from '@/lib/print/print-filters'
import { openAuthedPdf } from '@/lib/print/open-pdf'
import { formatDateTime } from '@/lib/format-date'
import MultiSelectPopover from '@/components/classic/MultiSelectPopover'
import { ChipMultiSelect, today, fmtMoney, lineUntax } from './shared'

// 操作日志 detail 是写入时(app/api/waves/**)拼好的中文句子，只读展示时按已知模板做最佳努力翻译；
// 不认识的格式原样透出
function translateWaveLogDetail(detail: string, isEn: boolean): string {
  if (!isEn) return detail
  let m = detail.match(/^创建拣货波次: (.+)$/)
  if (m) return `Created pick wave: ${m[1]}`
  m = detail.match(/^更新拣货波次: (.+)$/)
  if (m) return `Updated pick wave: ${m[1]}`
  m = detail.match(/^删除拣货波次: (.+)$/)
  if (m) return `Deleted pick wave: ${m[1]}`
  m = detail.match(/^标记完成：批次 (.+) 已完成配送$/)
  if (m) return `Marked completed: batch ${m[1]} delivery done`
  m = detail.match(/^标记分配完成：批次 (.+)$/)
  if (m) return `Marked assignment done: batch ${m[1]}`
  m = detail.match(/^撤销分配完成：批次 (.+)$/)
  if (m) return `Undid assignment done: batch ${m[1]}`
  m = detail.match(/^确认出发：批次 (.+)，(\d+) 个订单交货日期=(.+)$/)
  if (m) return `Confirmed departure: batch ${m[1]}, ${m[2]} orders delivery date=${m[3]}`
  m = detail.match(/^从波次 (.+) 移除 (\d+) 个订单$/)
  if (m) return `Removed ${m[2]} orders from wave ${m[1]}`
  m = detail.match(/^分配 (\d+) 个订单到波次 (.+)$/)
  if (m) return `Assigned ${m[1]} orders to wave ${m[2]}`
  m = detail.match(/^解锁批次 (.+)$/)
  if (m) return `Unlocked batch ${m[1]}`
  return detail
}

type BatchLine = OrderLine & { product?: { template?: { weight?: number | null } | null } | null }

function lineWeight(l: BatchLine): number {
  const w = Number(l.product?.template?.weight ?? 0)
  return w * Number(l.orderedQty)
}

interface WavePallet {
  id: string
  seq: number
  label: string | null
  items: Array<{ orderId: string }>
}

interface Wave {
  id: string
  orderIds: string[]
  driverSlotId: string | null
  driverName: string | null
  timeOfDay: string | null
  assignmentDoneAt: string | null
  dispatchedAt: string | null
  completedAt: string | null
  pickLockedAt: string | null
  pickLockedBy: string | null
  pallets: WavePallet[]
}

interface PalletGroup {
  seq: number
  orders: Order[]
}

interface BatchGroup {
  waveId: string
  driverName: string
  timeOfDay: string
  pickLockedAt: string | null
  pickLockedBy: string | null
  pallets: PalletGroup[]
  unassignedOrders: Order[]
  orders: Order[]
  totalAmount: number
  untaxTotal: number
  totalWeight: number
}

// SSOT: 波次归属直接读 wave.driverName/timeOfDay/pallets(真实字段)，
// 不再通过过期的 wave.driverSlotId 反查 DriverSlot——一个波次现在可能横跨多个托盘，
// 单值反查只能代表其中一个，会导致徽章/筛选/打印用错快照(见 2026-07-10 复盘)。
function waveLabel(g: { driverName: string; timeOfDay: string }, isEn: boolean): string {
  return [g.driverName || (isEn ? 'Unassigned' : '未分配'), g.timeOfDay ? g.timeOfDay.toUpperCase() : ''].filter(Boolean).join(' ')
}

interface ActionLogRow {
  id: string
  userName: string | null
  userEmail: string | null
  detail: string | null
  action: string
  createdAt: string
}

// ─── PrintQueue ───────────────────────────────────────────────────────────────
// 打印不再靠 window.open 开新标签页去导航 /classic/print/dispatch/[type]——两个原因都致命：
// 1) "先开空白页、锁定接口返回后再跳转"这套写法，装了 uBlock Origin / 隐私类插件的浏览器会
//    当成弹窗广告套路专门拦截，锁定的打印按钮越多拦得越频繁(2026-07-10 反馈)。
// 2) 就算不管插件，next.config.ts 的 X-Frame-Options: DENY / frame-ancestors 'none' 对全站
//    生效，任何用 <iframe src="/classic/print/...">发起 HTTP 导航加载该页面的做法都会被浏览器
//    拒绝渲染(哪怕同源)——这两个头是防点击劫持的安全基线，不能为了打印弱化。
// 改法：跳过"导航到打印页"这一步，直接在这里调用 fetchDispatchPrintHtml() 拿到生成好的整份
// HTML 字符串，灌进 <iframe srcDoc>——srcDoc 是内联文档，不发起 HTTP 请求/响应，不受上面两个
// 响应头管辖，因此从根上避开了拦截和安全头冲突。iframe 必须给真实尺寸（不能 0x0/display:none），
// 否则内容按 100% 展开时会跟着塌缩成 0，打印内容渲染不出来；用 left 负值挪到屏幕外做到视觉不可见。
const HIDDEN_PRINT_IFRAME_STYLE: React.CSSProperties = {
  position: 'fixed', top: 0, left: '-10000px', width: 900, height: 1200, border: 0,
}

interface PrintJob { id: number; html: string }

function PrintQueue({ jobs }: { jobs: PrintJob[] }) {
  return (
    <>
      {jobs.map(job => (
        <iframe key={job.id} srcDoc={job.html} style={HIDDEN_PRINT_IFRAME_STYLE} title={`print-${job.id}`} />
      ))}
    </>
  )
}

// ─── BatchCard ────────────────────────────────────────────────────────────────

function BatchCard({
  group,
  date,
  isPrinted,
  printedTimes: printedTimesOf,
  onConfirmReprint,
  canUnlock,
  filter,
  isEn,
  onPrint,
  onLockChange,
  onQueuePrint,
}: {
  group: BatchGroup
  date: string
  isPrinted: boolean
  /** 该批次某类单据已打印次数（服务端痕迹） */
  printedTimes: (docType: string) => number
  /** 已打印过时弹二次确认；返回 false 表示用户取消，不要打 */
  onConfirmReprint: (docType: string, label: string) => boolean
  canUnlock: boolean
  /** 当前生效的内容筛选（客户/商品）；必须原样带进每一个打印入口，
      否则会出现"屏幕上筛了、打出来是全量"的错打 */
  filter: PrintContentFilter
  isEn: boolean
  onPrint: () => void
  onLockChange: () => void
  onQueuePrint: (html: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  // 每个托盘（子批次）自己的打印按钮各自忙碌，不跟整卡片的 busy 共用一个开关，
  // 否则点一个托盘的按钮会把同卡片其它托盘/整卡按钮也一起 disable。
  const [palletBusy, setPalletBusy] = useState<Record<number, boolean>>({})
  const { waveId, driverName, timeOfDay, pickLockedAt, pickLockedBy, pallets, unassignedOrders, orders, totalAmount, untaxTotal } = group
  const label = waveLabel(group, isEn)
  const uniqueCustomers = new Set(orders.map(o => o.restaurantId)).size

  // 点任何打印按钮(送货单/汇总单/销售单)都必须自动锁定批次，不能只有拣货单锁——
  // 否则打印后调度台仍能改派，纸质单据和系统状态就对不上了(2026-07-10 复盘)。
  // 锁定成功后现取现渲染 HTML，交给 onQueuePrint 挂进隐藏 iframe(见 PrintQueue)，不再导航。
  //
  // 锁定本身是静默的 API 调用，之前打印完毫无提示，运营主管事后想改批次才会突然撞见
  // "已锁定"报错，一头雾水（2026-07-17 反馈）。这里只在批次"这一次点击前还没被锁定"时
  // 提示一次，避免同一批次反复打印时每次都弹一遍变成骚扰。
  function notifyFirstLock() {
    if (pickLockedAt) return
    toast.success(
      isEn
        ? 'Printed · this batch is now locked (unlock with the 🔒 button if you need to keep editing)'
        : '打印成功 · 该批次已自动锁定（如需继续调整，请点🔒解锁按钮）',
    )
  }

  async function print(type: 'delivery' | 'summary' | 'sales') {
    const label = type === 'delivery' ? (isEn ? 'delivery note' : '送货单')
      : type === 'sales' ? (isEn ? 'sales order' : '销售单')
      : (isEn ? 'summary' : '汇总单')
    if (!onConfirmReprint(type, label)) return
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', printType: type })
      notifyFirstLock()
      if (type === 'summary') {
        // 汇总单走真·服务端 PDF（无浏览器打印页眉），不再走隐藏 iframe + window.print()
        await openAuthedPdf(buildDispatchSummaryPdfUrl({ date, waveIds: [waveId], ...filter }))
      } else {
        const html = await fetchDispatchPrintHtml({ type, date, waveIds: [waveId], ...filter })
        onQueuePrint(html)
      }
      onPrint()
      // 记录打印动作到操作记录（失败不影响打印）
      try {
        await apiPost('/api/waves/print-log', { date, type, scope: 'batch', batchLabel: label, waveId })
      } catch { /* 日志失败静默 */ }
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setBusy(false)
    }
  }

  // Feature C：打印拣货单即触发批次锁定（重打=重新上锁）；锁定失败则不打印，避免"打印了但没锁"
  // 拣货单分实物(storable)/耗材(consumable)两份，供两个拣货员分开作业
  async function printPicking(variant: 'storable' | 'consumable') {
    if (!onConfirmReprint('picking', isEn ? 'picking list' : '拣货单')) return
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', variant })
      notifyFirstLock()
      // 拣货单走真·服务端 PDF（无浏览器打印页眉），不再走隐藏 iframe + window.print()
      await openAuthedPdf(buildDispatchPickingPdfUrl({ date, waveIds: [waveId], variant, ...filter }))
      onPrint()
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setBusy(false)
    }
  }

  // 显式手动上锁(不打印):人人可锁,配合下方「解锁」形成锁定/解锁切换。打印拣货单仍会自动上锁。
  async function lock() {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'manual' })
      toast.success(isEn ? 'Locked' : '已锁定')
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Lock failed' : '锁定失败'))
    } finally {
      setBusy(false)
    }
  }

  async function unlock() {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-unlock`, {})
      toast.success(isEn ? 'Unlocked' : '已解锁')
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Unlock failed' : '解锁失败'))
    } finally {
      setBusy(false)
    }
  }

  // 单托盘打印：复用 dispatch-print-data 已有的 batchLabel 选择器("批次号 时段 司机名"，
  // 见 lib/print/dispatch-loader.ts)，只取这一个托盘的订单，不是整个波次。锁定仍锁整个
  // 波次(没有托盘级锁)，与"打印任何单据都自动锁批次防改派"的既有设计一致。
  function palletBatchLabel(seq: number): string {
    return `${seq} ${timeOfDay} ${driverName}`
  }

  async function printPalletPicking(seq: number, variant: 'storable' | 'consumable') {
    setPalletBusy(prev => ({ ...prev, [seq]: true }))
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', variant })
      notifyFirstLock()
      await openAuthedPdf(buildDispatchPickingPdfUrl({ date, batchLabel: palletBatchLabel(seq), variant, ...filter }))
      onPrint()
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setPalletBusy(prev => ({ ...prev, [seq]: false }))
    }
  }

  async function printPallet(seq: number, type: 'delivery' | 'summary' | 'sales') {
    setPalletBusy(prev => ({ ...prev, [seq]: true }))
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', printType: type })
      notifyFirstLock()
      if (type === 'summary') {
        await openAuthedPdf(buildDispatchSummaryPdfUrl({ date, batchLabel: palletBatchLabel(seq), ...filter }))
      } else {
        const html = await fetchDispatchPrintHtml({ type, date, batchLabel: palletBatchLabel(seq), ...filter })
        onQueuePrint(html)
      }
      onPrint()
      try {
        await apiPost('/api/waves/print-log', { date, type, scope: 'batch', batchLabel: `${label} · ${isEn ? 'Batch' : '批次'} ${seq}`, waveId })
      } catch { /* 日志失败静默 */ }
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setPalletBusy(prev => ({ ...prev, [seq]: false }))
    }
  }

  return (
    <div className={`bg-white rounded-lg border overflow-hidden ${isPrinted ? 'border-green-300' : 'border-gray-200'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span className="text-gray-400 text-sm">{expanded ? '▾' : '▸'}</span>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {pallets.length > 0 ? (
              pallets.map(p => (
                <span key={p.seq} className="bg-[#875A7B] text-white text-xs font-bold rounded px-2 py-0.5">
                  {isEn ? `Batch ${p.seq}` : `批次 ${p.seq}`}
                </span>
              ))
            ) : (
              <span className="bg-gray-200 text-gray-500 text-xs rounded px-2 py-0.5">{isEn ? 'No Pallet' : '未分托盘'}</span>
            )}
            {timeOfDay && (
              <span className="bg-blue-100 text-blue-700 text-xs font-medium rounded px-2 py-0.5 uppercase">
                {timeOfDay}
              </span>
            )}
            {driverName ? (
              <span className="font-medium text-gray-900 text-sm">{driverName}</span>
            ) : (
              <span className="text-gray-400 text-sm italic">{isEn ? 'Unassigned' : '未分配'}</span>
            )}
            <span className="text-xs text-gray-400">
              {isEn
                ? `${orders.length} orders · ${uniqueCustomers} customers · ${pallets.length} pallets`
                : `${orders.length} 单 · ${uniqueCustomers} 客户 · ${pallets.length} 托盘`}
            </span>
            {isPrinted && (
              <span className="text-xs text-green-600 font-medium bg-green-50 rounded px-1.5 py-0.5">
                {isEn ? '✓ Printed' : '✓ 已打印'}
              </span>
            )}
            {pickLockedAt && (
              <span className="text-xs text-amber-700 font-medium bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                {isEn ? '🔒 Picking' : '🔒 拣货中'}{pickLockedBy ? ` · ${pickLockedBy}` : ''}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-900 mr-2">€{fmtMoney(totalAmount)}</span>
          <span className="text-xs text-gray-400 mr-3">{isEn ? 'Excl. tax' : '未税'} €{fmtMoney(untaxTotal)}</span>
          {!pickLockedAt && (
            <button
              onClick={lock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
              title={isEn ? 'Lock this wave to prevent further dispatch changes (printing a picking list also auto-locks)' : '锁定该波次，防止调度台再改动（打印拣货单也会自动上锁）'}
            >
              {isEn ? '🔓 Lock' : '🔓 锁定'}
            </button>
          )}
          {pickLockedAt && canUnlock && (
            <button
              onClick={unlock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-40"
              title={isEn ? 'Unlock this wave (BOSS / WAREHOUSE only)' : '解锁该波次（仅 BOSS / WAREHOUSE 可操作）'}
            >
              {isEn ? '🔒 Unlock' : '🔒 解锁'}
            </button>
          )}
          <span className="inline-flex rounded border border-orange-400 overflow-hidden">
            <button
              onClick={() => printPicking('storable')}
              disabled={busy}
              title={isEn ? 'Full case/bag picking list' : '整箱整袋拣货单'}
              className="px-2.5 py-1 text-xs text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-40"
            >
              {isEn ? '📦 Full Case' : '📦 整箱整袋'}
            </button>
            <button
              onClick={() => printPicking('consumable')}
              disabled={busy}
              title={isEn ? 'Loose goods picking list' : '零散货拣货单'}
              className="px-2.5 py-1 text-xs text-orange-600 border-l border-orange-400 hover:bg-orange-50 transition-colors disabled:opacity-40"
            >
              {isEn ? '🧴 Loose Goods' : '🧴 零散货'}
            </button>
          </span>
          <button
            onClick={() => print('sales')}
            disabled={busy}
            title={isEn ? 'Print sales order for this wave (with prices, all pallets) · Printing auto-locks this batch' : '打印该波次销售单(含价格，含全部托盘) Sales Order · 打印会自动锁定该批次'}
            className="px-2.5 py-1 text-xs rounded border border-purple-400 text-purple-700 hover:bg-purple-50 transition-colors disabled:opacity-40"
          >
            {isEn ? '🧾 Sales Order' : '🧾 销售单'}
          </button>
          <button
            onClick={() => print('delivery')}
            disabled={busy}
            title={isEn ? 'Print delivery note for this wave (all pallets) · Printing auto-locks this batch' : '打印该波次送货单(含全部托盘) Delivery Note · 打印会自动锁定该批次'}
            className="px-2.5 py-1 text-xs rounded border border-blue-400 text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40"
          >
            {isEn ? '🚚 Delivery Note' : '🚚 送货单'}
          </button>
          <button
            onClick={() => print('summary')}
            disabled={busy}
            title={isEn ? 'Print delivery summary sheet for this wave (all pallets) · Printing auto-locks this batch' : '打印该波次送货汇总单(含全部托盘) Delivery Summary · 打印会自动锁定该批次'}
            className="px-2.5 py-1 text-xs rounded border border-green-500 text-green-700 hover:bg-green-50 transition-colors disabled:opacity-40"
          >
            {isEn ? '📋 Summary Sheet' : '📋 汇总单'}
          </button>
        </div>
      </div>

      {/* Order list：按托盘缩进分组，与调度台 BatchTab 的托盘 lane 结构对齐，
          让操作员看清"这一趟车里到底有几个托盘、分别装了哪些订单"(不再是打平的单张列表) */}
      {expanded && (
        <div className="border-t border-gray-100">
          {pallets.map(p => (
            <div key={p.seq}>
              <div className="px-5 py-1.5 bg-gray-50 flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-gray-500">
                  {isEn ? `Batch ${p.seq} · ${p.orders.length} orders` : `批次 ${p.seq} · ${p.orders.length} 单`}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="inline-flex rounded border border-orange-300 overflow-hidden">
                    <button
                      onClick={() => printPalletPicking(p.seq, 'storable')}
                      disabled={!!palletBusy[p.seq]}
                      title={isEn ? 'Full case/bag picking list for this pallet only' : '仅本托盘 · 整箱整袋拣货单'}
                      className="px-2 py-0.5 text-[11px] text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-40"
                    >
                      {isEn ? '📦 Full Case' : '📦 整箱整袋'}
                    </button>
                    <button
                      onClick={() => printPalletPicking(p.seq, 'consumable')}
                      disabled={!!palletBusy[p.seq]}
                      title={isEn ? 'Loose goods picking list for this pallet only' : '仅本托盘 · 零散货拣货单'}
                      className="px-2 py-0.5 text-[11px] text-orange-600 border-l border-orange-300 hover:bg-orange-50 transition-colors disabled:opacity-40"
                    >
                      {isEn ? '🧴 Loose Goods' : '🧴 零散货'}
                    </button>
                  </span>
                  <button
                    onClick={() => printPallet(p.seq, 'sales')}
                    disabled={!!palletBusy[p.seq]}
                    title={isEn ? 'Sales order for this pallet only · Printing auto-locks the whole batch' : '仅本托盘 · 销售单 · 打印会自动锁定整个批次'}
                    className="px-2 py-0.5 text-[11px] rounded border border-purple-300 text-purple-700 hover:bg-purple-50 transition-colors disabled:opacity-40"
                  >
                    {isEn ? '🧾 Sales Order' : '🧾 销售单'}
                  </button>
                  <button
                    onClick={() => printPallet(p.seq, 'delivery')}
                    disabled={!!palletBusy[p.seq]}
                    title={isEn ? 'Delivery note for this pallet only · Printing auto-locks the whole batch' : '仅本托盘 · 送货单 · 打印会自动锁定整个批次'}
                    className="px-2 py-0.5 text-[11px] rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40"
                  >
                    {isEn ? '🚚 Delivery Note' : '🚚 送货单'}
                  </button>
                  <button
                    onClick={() => printPallet(p.seq, 'summary')}
                    disabled={!!palletBusy[p.seq]}
                    title={isEn ? 'Delivery summary sheet for this pallet only · Printing auto-locks the whole batch' : '仅本托盘 · 送货汇总单 · 打印会自动锁定整个批次'}
                    className="px-2 py-0.5 text-[11px] rounded border border-green-400 text-green-700 hover:bg-green-50 transition-colors disabled:opacity-40"
                  >
                    {isEn ? '📋 Summary Sheet' : '📋 汇总单'}
                  </button>
                </div>
              </div>
              {p.orders.map(o => (
                <div key={o.id} className="flex items-center gap-3 pl-8 pr-5 py-2 hover:bg-gray-50 border-b border-gray-50">
                  <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
                  <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
                  <span className="text-sm font-medium text-gray-900 w-24 text-right">
                    €{fmtMoney(Number(o.totalAmount))}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {unassignedOrders.length > 0 && (
            <div>
              <div className="px-5 py-1.5 bg-amber-50 text-xs font-semibold text-amber-600">
                {isEn ? `No Pallet Assigned · ${unassignedOrders.length} orders` : `未分配托盘 · ${unassignedOrders.length} 单`}
              </div>
              {unassignedOrders.map(o => (
                <div key={o.id} className="flex items-center gap-3 pl-8 pr-5 py-2 hover:bg-gray-50 border-b border-gray-50">
                  <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
                  <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
                  <span className="text-sm font-medium text-gray-900 w-24 text-right">
                    €{fmtMoney(Number(o.totalAmount))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── BatchSections ────────────────────────────────────────────────────────────

function BatchSections({
  batchGroups,
  date,
  printStatus,
  onConfirmReprint,
  canUnlock,
  filter,
  isEn,
  onPrint,
  onLockChange,
  onQueuePrint,
}: {
  batchGroups: BatchGroup[]
  date: string
  printStatus: PrintStatus
  onConfirmReprint: (waveId: string, docType: string, label: string) => boolean
  canUnlock: boolean
  filter: PrintContentFilter
  isEn: boolean
  onPrint: (waveId: string) => void
  onLockChange: () => void
  onQueuePrint: (html: string) => void
}) {
  const amGroups = batchGroups.filter(g => g.timeOfDay === 'am')
  const pmGroups = batchGroups.filter(g => g.timeOfDay === 'pm')
  const otherGroups = batchGroups.filter(g => g.timeOfDay !== 'am' && g.timeOfDay !== 'pm')

  function renderGroup(g: BatchGroup) {
    return (
      <BatchCard
        key={g.waveId}
        group={g}
        date={date}
        isPrinted={printedTimes(printStatus, g.waveId) > 0}
        printedTimes={(docType: string) => printedTimes(printStatus, g.waveId, docType)}
        onConfirmReprint={(docType: string, label: string) => onConfirmReprint(g.waveId, docType, label)}
        canUnlock={canUnlock}
        filter={filter}
        isEn={isEn}
        onPrint={() => onPrint(g.waveId)}
        onLockChange={onLockChange}
        onQueuePrint={onQueuePrint}
      />
    )
  }

  return (
    <div className="space-y-4">
      {amGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">{isEn ? 'AM' : 'AM 上午'}</span>
            <span className="text-xs text-gray-400">{isEn ? `${amGroups.length} waves` : `${amGroups.length} 波次`}</span>
            <div className="flex-1 h-px bg-blue-100" />
          </div>
          {amGroups.map(renderGroup)}
        </div>
      )}
      {pmGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-orange-500 uppercase tracking-wider">{isEn ? 'PM' : 'PM 下午'}</span>
            <span className="text-xs text-gray-400">{isEn ? `${pmGroups.length} waves` : `${pmGroups.length} 波次`}</span>
            <div className="flex-1 h-px bg-orange-100" />
          </div>
          {pmGroups.map(renderGroup)}
        </div>
      )}
      {otherGroups.length > 0 && (
        <div className="space-y-2">
          {(amGroups.length > 0 || pmGroups.length > 0) && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{isEn ? 'Other' : '其他'}</span>
              <span className="text-xs text-gray-400">{isEn ? `${otherGroups.length} waves` : `${otherGroups.length} 波次`}</span>
              <div className="flex-1 h-px bg-gray-100" />
            </div>
          )}
          {otherGroups.map(renderGroup)}
        </div>
      )}
    </div>
  )
}

// ─── PrintCenter ──────────────────────────────────────────────────────────────

/**
 * 打印状态（20260811 改）
 * ----------------------------------------------------------------------------
 * 此前「✓ 已打印」存在 localStorage(`veggie-printed-batches-{date}`)：换台电脑、
 * 换浏览器、清缓存就没了，页面上还有个「清除已打印记录」按钮能随手抹掉。
 * 后果不是显示难看 —— 打印员 A 打过的批次，打印员 B 那边显示成没打过，
 * 于是漏打或重复打。
 *
 * 现改为读服务端 /api/waves/print-status：数据来自每次打印本就写下的 ActionLog，
 * 没有新增写入路径。跨设备一致，且能给出「打了几次、谁打的、什么时候」。
 */
interface PrintMark { count: number; lastAt: string; lastBy: string }
type PrintStatus = {
  waves: Record<string, Record<string, PrintMark>>
  legacyCount: number
  printedWaveCount: number
  totalWaveCount: number
}
const EMPTY_STATUS: PrintStatus = { waves: {}, legacyCount: 0, printedWaveCount: 0, totalWaveCount: 0 }

/** 该批次的某类单据打过几次；docType 省略则看任意一类 */
function printedTimes(status: PrintStatus, waveId: string, docType?: string): number {
  const slot = status.waves[waveId]
  if (!slot) return 0
  if (docType) return slot[docType]?.count ?? 0
  return Object.values(slot).reduce((s, m) => s + m.count, 0)
}

export default function PrintCenter({ refreshKey = 0, onRefresh }: { refreshKey?: number; onRefresh?: () => void }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  // 解锁权限的唯一开关：当前先全部放开（能进打印中心的人都可解锁）。
  // 日后要收口到某个具体用户，把这里换成 useAbility() 判断即可（如 ability.userId === 'xxx'）。
  const canUnlock = true

  const [date, setDate] = useState(today)
  const [waves, setWaves] = useState<Wave[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [sortMode, setSortMode] = useState<'batch' | 'driver' | 'time'>('batch')
  const [driverFilter, setDriverFilter] = useState<string[]>([])
  const [timeFilter, setTimeFilter] = useState<string[]>([])
  const [batchFilter, setBatchFilter] = useState<string[]>([])
  // 台账 D3：客户 / 商品两维内容筛选。线路维度由上面的司机 + 批次承担。
  const [customerFilter, setCustomerFilter] = useState<string[]>([])
  const [productFilter, setProductFilter] = useState<string[]>([])
  const [printStatus, setPrintStatus] = useState<PrintStatus>(EMPTY_STATUS)
  const [logs, setLogs] = useState<ActionLogRow[]>([])
  // 打印队列：每次打印挂一个隐藏 iframe(见 PrintQueue)，不主动卸载——iframe 是 0 尺寸挪到
  // 屏幕外的轻量元素，攒一整天的打印任务对内存无实质影响，比"猜多久该卸载"更简单可靠
  // (太早卸载可能打断还没弹出/还没关闭的系统打印对话框)。
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([])
  const printJobSeq = useRef(0)
  const queuePrint = useCallback((html: string) => {
    printJobSeq.current += 1
    setPrintJobs(prev => [...prev, { id: printJobSeq.current, html }])
  }, [])

  const loadPrintStatus = useCallback(async () => {
    try {
      const s = await apiGet<PrintStatus>(`/api/waves/print-status?date=${date}`)
      setPrintStatus(s ?? EMPTY_STATUS)
    } catch {
      // 打印状态取不到不该挡住打印本身：退回"全都没打过"，宁可多问一次也不漏打
      setPrintStatus(EMPTY_STATUS)
    }
  }, [date])

  useEffect(() => { void loadPrintStatus() }, [loadPrintStatus])

  // 打印动作发生后重新拉一次服务端状态。不做本地乐观更新——本地猜的状态与
  // 服务端不一致时，用户看到的"已打印"可能根本没落库，那正是原来那个 bug。
  const markPrinted = useCallback(() => { void loadPrintStatus() }, [loadPrintStatus])

  /**
   * 重复打印二次确认。
   * 原先重打是**刻意静默**的（notifyFirstLock 里"已锁定就不再提示"，理由是
   * 避免骚扰）。但静默的代价是没人知道自己在重打 —— 纸张与人工都白费，更麻烦的是
   * 两份内容不同的单据同时在仓库里流转。改为：打过才问，没打过不打扰。
   */
  const confirmReprint = useCallback((waveId: string, docType: string, label: string): boolean => {
    const n = printedTimes(printStatus, waveId, docType)
    if (n === 0) return true
    const mark = printStatus.waves[waveId]?.[docType]
    const when = mark ? new Date(mark.lastAt).toLocaleString(isEn ? 'en-IE' : 'zh-CN') : ''
    return window.confirm(
      isEn
        ? `This batch's ${label} has already been printed ${n} time(s).\nLast: ${when} by ${mark?.lastBy ?? '—'}.\n\nPrint again?`
        : `该批次的${label}已经打印过 ${n} 次。\n最近一次：${when} · ${mark?.lastBy ?? '—'}\n\n确定要再打一次吗？`,
    )
  }, [printStatus, isEn])

  // Feature B：打印中心按批次阶段取数（assignmentDoneAt 已回填、或已被拣货锁定的 wave，
  // 且未 completed）——单看 assignmentDoneAt 会漏掉"已锁定但分配完成被撤销"的批次，
  // 运营主管找不到自己刚锁的批次会以为数据丢了(20260717 反馈)。分配完成即可见，
  // 不必等「确认出发」回填 deliveryDate。
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const waveData = await apiGet<Wave[]>(`/api/waves?date=${date}`)
      const visible = waveData.filter(w => (w.assignmentDoneAt != null || w.pickLockedAt != null) && !w.completedAt)
      const orderIds = Array.from(new Set(visible.flatMap(w => w.orderIds)))
      const ordersData = orderIds.length > 0
        ? await apiGet<Order[]>(`/api/orders?include_lines=true&ids=${orderIds.join(',')}`)
        : []
      setWaves(visible)
      setOrders(Array.isArray(ordersData) ? ordersData : [])
    } catch {
      setWaves([])
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [date])

  // 操作记录：锁定/解锁/打印都写在 resource=picking-wave，detail 里带配送日期，
  // 按当前选中的配送日期过滤，只显示屏幕上这批批次的操作。
  const loadLogs = useCallback(async () => {
    try {
      const res = await apiGet<{ logs: ActionLogRow[] } | ActionLogRow[]>('/api/action-logs?resource=picking-wave&take=100')
      const arr: ActionLogRow[] = Array.isArray(res) ? res : (res.logs ?? [])
      setLogs(arr.filter(l => l.detail?.includes(date)))
    } catch {
      setLogs([])
    }
  }, [date])

  const refresh = useCallback(() => { load(); loadLogs() }, [load, loadLogs])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadLogs() }, [loadLogs])

  // 页头「刷新」：跳过首次挂载，之后每次 refreshKey 变化重拉当前日期的批次+日志
  useEffect(() => {
    if (refreshKey === 0) return
    refresh()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const ordersById = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders])

  const contentFilter: PrintContentFilter = useMemo(
    () => ({ customerIds: customerFilter, productIds: productFilter }),
    [customerFilter, productFilter],
  )

  /**
   * 内容筛选（客户 / 商品）后的订单。
   * ⚠️ 这里调的 applyPrintContentFilter 与服务端 dispatch-loader 是**同一段代码**
   * （lib/print/print-filters.ts）——「筛选结果条数与预览一致」这条验收标准
   * 靠的是共用实现，不是两边各写一遍再指望它们凑巧一致。
   * 商品筛选把行砍掉后，卡片金额同样按剩余行重算，与纸面同口径。
   */
  const filteredOrdersById = useMemo(() => {
    if (!hasContentFilter(contentFilter)) return ordersById
    const kept = applyPrintContentFilter(
      orders.map(o => ({ ...o, customerId: o.restaurantId, lines: o.lines ?? [] })),
      contentFilter,
    )
    const lineFiltered = productFilter.length > 0
    return new Map<string, Order>(kept.map(o => [
      o.id,
      (lineFiltered
        ? { ...o, totalAmount: o.lines.reduce((s, l) => s + Number(l.subtotal ?? 0), 0) }
        : o) as unknown as Order,
    ]))
  }, [orders, ordersById, contentFilter, productFilter])

  // 每张卡片 = 一个 wave，与调度台一一对应；分组直接读 wave 自身字段
  // (driverName/timeOfDay/pallets)，不再反查过期的 driverSlotId 快照。
  const buildWaveGroups = useCallback((lookup: Map<string, Order>) => {
    return waves
      .map(w => {
        const ords = w.orderIds.map(id => lookup.get(id)).filter((o): o is Order => !!o)
        const inPallet = new Set<string>()
        const pallets: PalletGroup[] = (w.pallets ?? [])
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map(p => {
            const orderIds = [...new Set(p.items.map(it => it.orderId))]
            orderIds.forEach(id => inPallet.add(id))
            return {
              seq: p.seq,
              orders: orderIds.map(id => lookup.get(id)).filter((o): o is Order => !!o),
            }
          })
          .filter(p => p.orders.length > 0)
        const unassignedOrders = ords.filter(o => !inPallet.has(o.id))
        return {
          waveId: w.id,
          driverName: w.driverName ?? '',
          timeOfDay: (w.timeOfDay ?? '').toLowerCase(),
          pickLockedAt: w.pickLockedAt,
          pickLockedBy: w.pickLockedBy,
          pallets,
          unassignedOrders,
          orders: ords,
        }
      })
      .filter(g => g.orders.length > 0)
  }, [waves])

  const waveGroups = useMemo(() => buildWaveGroups(filteredOrdersById), [buildWaveGroups, filteredOrdersById])

  /**
   * 选项列表一律从**未经内容筛选**的数据算出来。
   * 若从筛选后的结果算，选了客户 A 之后其余客户/司机的选项会当场消失，
   * 已选中的那个也可能因为渲染不出来而取消不掉 —— 筛选器把用户锁在自己的选择里。
   */
  const filterOptions = useMemo(() => {
    const all = buildWaveGroups(ordersById)
    const drivers = new Set<string>()
    const times = new Set<string>()
    const batches = new Set<number>()
    const customers = new Map<string, string>()
    const products = new Map<string, string>()
    for (const g of all) {
      if (g.driverName) drivers.add(g.driverName)
      if (g.timeOfDay) times.add(g.timeOfDay)
      for (const p of g.pallets) batches.add(p.seq)
      for (const o of g.orders) {
        if (o.restaurantId) customers.set(o.restaurantId, o.restaurantName ?? o.restaurantId)
        for (const l of o.lines ?? []) {
          if (l.productId) products.set(l.productId, l.productName ?? l.productId)
        }
      }
    }
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      batches: [...batches].sort((a, b) => a - b).map(String),
      customers: [...customers].map(([value, label]) => ({ value, label })).sort(byLabel),
      products: [...products].map(([value, label]) => ({ value, label })).sort(byLabel),
    }
  }, [buildWaveGroups, ordersById])

  const filteredWaveGroups = useMemo(() => {
    return waveGroups.filter(g => {
      if (driverFilter.length > 0 && !driverFilter.includes(g.driverName)) return false
      if (timeFilter.length > 0 && !timeFilter.includes(g.timeOfDay)) return false
      if (batchFilter.length > 0 && !g.pallets.some(p => batchFilter.includes(String(p.seq)))) return false
      return true
    })
  }, [waveGroups, driverFilter, timeFilter, batchFilter])

  const batchGroups: BatchGroup[] = useMemo(() => {
    const groups = filteredWaveGroups.map(g => ({
      ...g,
      totalAmount: g.orders.reduce((s, o) => s + Number(o.totalAmount), 0),
      untaxTotal: g.orders.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineUntax(l), 0), 0),
      totalWeight: g.orders.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineWeight(l as BatchLine), 0), 0),
    }))

    return groups.sort((a, b) => {
      const aNum = a.pallets[0]?.seq ?? 0
      const bNum = b.pallets[0]?.seq ?? 0
      if (sortMode === 'batch') return aNum - bNum || a.timeOfDay.localeCompare(b.timeOfDay) || a.driverName.localeCompare(b.driverName)
      if (sortMode === 'time') return a.timeOfDay.localeCompare(b.timeOfDay) || aNum - bNum || a.driverName.localeCompare(b.driverName)
      return a.driverName.localeCompare(b.driverName) || aNum - bNum
    })
  }, [filteredWaveGroups, sortMode])

  // 顶部「全部打印」跟随筛选：无筛选=整日全部；有筛选=只打屏幕上可见的这批波次（传 waveIds）。
  // 客户/商品筛选同样要落进 waveIds —— 不带的话服务端走「整日全部批次」分支，
  // 会把屏幕上根本没显示的波次（未分配完成/已完成）也算进去，条数就与预览对不上了。
  const isFiltered = driverFilter.length > 0 || timeFilter.length > 0 || batchFilter.length > 0
    || hasContentFilter(contentFilter)
  const filteredWaveIds = isFiltered ? batchGroups.map(g => g.waveId) : undefined
  const visibleOrderCount = batchGroups.reduce((s, g) => s + g.orders.length, 0)

  // 顶部「全部打印」也要给每个可见波次自动上锁，跟拣货单一致——否则批量打印销售单后
  // 调度台仍能改派，纸质单据和系统状态就对不上了。锁定结果出来后现取现渲染 HTML，交给
  // queuePrint 挂进隐藏 iframe，不再导航到打印页(见 PrintQueue 顶部注释)。
  /**
   * 批量打印的二次确认。逐批弹窗会弹到手软，所以改成问一次：
   * 「这 N 批里有 M 批已经打过了，仍要全部重打吗」。
   * 批量入口最容易造成重复打印 —— 一次就盖掉全天所有批次。
   */
  function confirmBulkReprint(docType: string, label: string): boolean {
    const dup = batchGroups.filter(g => printedTimes(printStatus, g.waveId, docType) > 0)
    if (dup.length === 0) return true
    return window.confirm(
      isEn
        ? `${dup.length} of ${batchGroups.length} batches have already had their ${label} printed.\n\nPrint all again?`
        : `这 ${batchGroups.length} 批里，有 ${dup.length} 批的${label}已经打印过。\n\n确定要全部再打一次吗？`,
    )
  }

  async function bulkPrint() {
    const type = 'sales'
    if (!confirmBulkReprint(type, isEn ? 'sales order' : '销售单')) return
    const results = await Promise.allSettled(
      batchGroups.map(g => apiPost(`/api/waves/${g.waveId}/pick-lock`, { reason: 'print', printType: type }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    try {
      const html = await fetchDispatchPrintHtml({ type, date, waveIds: filteredWaveIds, ...contentFilter })
      queuePrint(html)
    } catch {
      toast.error(isEn ? 'Print failed' : '打印失败')
    }
    try {
      await apiPost('/api/waves/print-log', { date, type, scope: isFiltered ? 'filtered' : 'bulk', count: batchGroups.length })
    } catch { /* 日志失败静默 */ }
    markPrinted()
    if (failed > 0) toast.error(isEn ? `${failed} waves failed to lock` : `${failed} 个波次锁定失败`)
    refresh()
  }

  // Feature C：「打印拣货单」= 对当前可见波次批量上锁，锁定失败的波次不阻断其余波次打印
  // 分实物/耗材两份，供两个拣货员分开作业；打印范围与锁定范围一致（跟随筛选）
  async function bulkPrintPicking(variant: 'storable' | 'consumable') {
    if (!confirmBulkReprint('picking', isEn ? 'picking list' : '拣货单')) return
    const results = await Promise.allSettled(
      batchGroups.map(g => apiPost(`/api/waves/${g.waveId}/pick-lock`, { reason: 'print', variant }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    try {
      await openAuthedPdf(buildDispatchPickingPdfUrl({ date, waveIds: filteredWaveIds, variant, ...contentFilter }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    }
    markPrinted()
    if (failed > 0) toast.error(isEn ? `${failed} waves failed to lock` : `${failed} 个波次锁定失败`)
    refresh()
  }

  const grandTotal = batchGroups.reduce((s, g) => s + g.totalAmount, 0)

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">{isEn ? 'Delivery Date' : '配送日期'}</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 ml-2">
            {loading ? (
              <span>{isEn ? 'Loading...' : '加载中...'}</span>
            ) : (
              <>
                <span>
                  {/* 三个数字必须同源：波次数与金额本来就取自筛选后的 batchGroups，
                      订单数若还用未筛的 orders.length，就会出现「共 4 单 · €100」这种
                      自相矛盾的抬头（4 单是全量、100 是筛后金额）。 */}
                  {isEn
                    ? `Total ${visibleOrderCount} orders · ${batchGroups.length} waves assigned · €${fmtMoney(grandTotal)}`
                    : `共 ${visibleOrderCount} 单 · ${batchGroups.length} 个已安排波次 · €${fmtMoney(grandTotal)}`}
                </span>
                {/* 原本这里是「清除已打印记录」——那是 localStorage 时代的产物。
                    现在痕迹在服务端(ActionLog)，是审计数据，不该被前端一键抹掉。
                    换成打印员真正需要的那个数：还剩几批没打。 */}
                {batchGroups.length > 0 && (() => {
                  const printed = batchGroups.filter(g => printedTimes(printStatus, g.waveId) > 0).length
                  const left = batchGroups.length - printed
                  return (
                    <span className={`ml-2 text-xs font-semibold ${left > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                      {left > 0
                        ? (isEn ? `· ${left} not printed yet` : `· 还剩 ${left} 批未打`)
                        : (isEn ? '· all printed' : '· 全部已打印')}
                    </span>
                  )
                })()}
                {printStatus.legacyCount > 0 && (
                  <span className="ml-2 text-xs text-gray-400">
                    {/* 20260811 之前的日志没有结构化打印类型，无法判定属于哪种单据，
                        也无法与"手动锁定"区分，所以只提示条数，不冒充"已打印" */}
                    {isEn
                      ? `(${printStatus.legacyCount} earlier log entries, type unknown)`
                      : `（另有 ${printStatus.legacyCount} 条早期记录，类型未知）`}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-white transition-colors hover:opacity-90"
                style={{ background: '#875A7B' }}
                title={isEn ? 'Refetch data for the current tab' : '重新拉取当前标签页的数据'}
              >
                🔄 {isEn ? 'Refresh' : '刷新'}
              </button>
            )}
            {isFiltered && (
              <span className="text-xs text-[#875A7B] font-medium" title={isEn ? 'The print buttons above have switched to "print current filtered results only"' : '顶部打印按钮已切换为「仅打印当前筛选结果」'}>
                {isEn
                  ? `Filtered · Printing ${batchGroups.length} waves / ${visibleOrderCount} orders`
                  : `已筛选 · 打印 ${batchGroups.length} 波次 / ${visibleOrderCount} 单`}
              </span>
            )}
            <span className="inline-flex rounded overflow-hidden">
              <button
                onClick={() => bulkPrintPicking('storable')}
                disabled={batchGroups.length === 0}
                title={isEn
                  ? (isFiltered ? 'Current filtered waves · Full case/bag picking list' : 'All waves · Full case/bag picking list')
                  : (isFiltered ? '当前筛选波次 · 整箱整袋拣货单' : '全部波次 · 整箱整袋拣货单')}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                {isEn
                  ? `${isFiltered ? 'Filtered Picking List' : 'All Picking Lists'} 📦 Full Case`
                  : `${isFiltered ? '筛选拣货单' : '全部拣货单'} 📦 整箱整袋`}
              </button>
              <button
                onClick={() => bulkPrintPicking('consumable')}
                disabled={batchGroups.length === 0}
                title={isEn
                  ? (isFiltered ? 'Current filtered waves · Loose goods picking list' : 'All waves · Loose goods picking list')
                  : (isFiltered ? '当前筛选波次 · 零散货拣货单' : '全部波次 · 零散货拣货单')}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white border-l border-orange-300 hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                {isEn ? '🧴 Loose Goods' : '🧴 零散货'}
              </button>
            </span>
            <button
              onClick={bulkPrint}
              disabled={batchGroups.length === 0}
              title={(isEn
                ? (isFiltered ? 'Print sales orders (with prices) for the current filtered waves only' : 'Print sales orders (with prices) for all waves')
                : (isFiltered ? '仅打印当前筛选波次的销售单(含价格)' : '打印全部波次的销售单(含价格)')) + (isEn ? ' · Printing auto-locks these batches' : ' · 打印会自动锁定这些批次')}
              className="px-3 py-1.5 text-xs rounded bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 disabled:hover:bg-purple-500"
            >
              {isEn
                ? (isFiltered ? 'Print Filtered Sales Orders' : 'Print All Sales Orders')
                : (isFiltered ? '打印筛选销售单' : '全部打印销售单')}
            </button>
          </div>
        </div>

        {/* Sort + Filters */}
        <div className="flex items-center gap-4 flex-wrap border-t border-gray-100 pt-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">{isEn ? 'Sort:' : '排序:'}</span>
            {(['batch', 'driver', 'time'] as const).map(m => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  sortMode === m ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-500 hover:border-[#875A7B]'
                }`}
              >
                {isEn
                  ? (m === 'batch' ? 'Batch' : m === 'driver' ? 'Driver' : 'Time')
                  : (m === 'batch' ? '批次' : m === 'driver' ? '司机' : '时段')}
              </button>
            ))}
          </div>
          <ChipMultiSelect
            label={isEn ? 'Driver' : '司机'}
            options={filterOptions.drivers}
            selected={driverFilter}
            onChange={setDriverFilter}
          />
          <ChipMultiSelect
            label={isEn ? 'Time' : '时段'}
            options={filterOptions.times}
            selected={timeFilter}
            onChange={setTimeFilter}
          />
          <ChipMultiSelect
            label={isEn ? 'Batch' : '批次'}
            options={filterOptions.batches}
            selected={batchFilter}
            onChange={setBatchFilter}
          />
          {/* 客户 / 商品是「同一批波次里再挑一部分」，选项动辄上百条，
              用可搜索的下拉而不是平铺 chip（司机/时段/批次只有个位数才平铺）。 */}
          <MultiSelectPopover
            label={isEn ? 'Customer' : '客户'}
            options={filterOptions.customers}
            selected={customerFilter}
            onChange={setCustomerFilter}
            searchable
            searchPlaceholder={isEn ? 'Search customer…' : '搜索客户…'}
            buttonLabel={n => n === 0
              ? (isEn ? 'All customers' : '全部客户')
              : (isEn ? `Customer: ${n}` : `客户：${n} 项`)}
          />
          <MultiSelectPopover
            label={isEn ? 'Product' : '商品'}
            options={filterOptions.products}
            selected={productFilter}
            onChange={setProductFilter}
            searchable
            searchPlaceholder={isEn ? 'Search product…' : '搜索商品…'}
            buttonLabel={n => n === 0
              ? (isEn ? 'All products' : '全部商品')
              : (isEn ? `Product: ${n}` : `商品：${n} 项`)}
          />
          {productFilter.length > 0 && (
            <span className="text-xs text-amber-600" title={isEn
              ? 'Only the selected products are printed; order totals on screen and on paper both count the remaining lines only'
              : '只打印所选商品的行；屏幕与纸面的订单金额都只统计剩余行'}>
              {isEn ? '⚠ Partial documents' : '⚠ 部分单据'}
            </span>
          )}
        </div>
      </div>

      {/* Batch cards —— loading 只在"还没有任何数据"时整屏替换成占位符；已有数据后的后台刷新
          (每次打印/锁定都会 refresh)不再卸载 BatchSections/BatchCard,否则每张卡片的本地展开状态
          (BatchCard 的 expanded useState)会随组件被卸载一起清零,表现为"打印一个就自动收起"。
          批次列表在刷新期间保留旧数据静默过渡，新数据到手后自动替换，不会有可感知的空白闪烁。 */}
      {loading && batchGroups.length === 0 ? (
        <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
      ) : batchGroups.length === 0 ? (
        <div className="text-center text-gray-400 py-16 text-sm">
          {isEn ? `No fully assigned waves for ${date}` : `${date} 没有已分配完成的波次`}
        </div>
      ) : (
        <BatchSections
          batchGroups={batchGroups}
          date={date}
          printStatus={printStatus}
          onConfirmReprint={confirmReprint}
          canUnlock={canUnlock}
          filter={contentFilter}
          isEn={isEn}
          onPrint={markPrinted}
          onLockChange={refresh}
          onQueuePrint={queuePrint}
        />
      )}

      {/* 操作记录（当前配送日期）：锁定 / 解锁 / 打印 */}
      <OperationLog logs={logs} isEn={isEn} />

      {/* 隐藏打印队列：不占布局位置(position:fixed 挪出屏幕)，放在哪里都一样 */}
      <PrintQueue jobs={printJobs} />
    </div>
  )
}

// ─── OperationLog ─────────────────────────────────────────────────────────────

function OperationLog({ logs, isEn }: { logs: ActionLogRow[]; isEn: boolean }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{isEn ? 'Operation Log (current delivery date)' : '操作记录（当前配送日期）'}</span>
        <span className="text-xs text-gray-400">
          {isEn ? `${logs.length} entries · Lock / Unlock / Print` : `共 ${logs.length} 条 · 锁定 / 解锁 / 打印`}
        </span>
      </div>
      {logs.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">
          {isEn ? 'No operation logs for this delivery date' : '该配送日期暂无操作记录'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="px-4 py-2 font-medium w-44">{isEn ? 'Time' : '时间'}</th>
                <th className="px-3 py-2 font-medium w-32">{isEn ? 'User' : '操作人'}</th>
                <th className="px-3 py-2 font-medium">{isEn ? 'Action' : '操作内容'}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                    {formatDateTime(log.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{log.userName ?? log.userEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{log.detail ?? log.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
