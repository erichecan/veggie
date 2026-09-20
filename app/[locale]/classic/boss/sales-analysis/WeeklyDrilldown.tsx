'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import DimensionPanel, { type TimeSel } from './DimensionPanel'

const PURPLE = '#875A7B'
const WEEKS_PAGE_SIZE = 8
const MONTHS_PAGE_SIZE = 12
/**
 * 后端 resolveDateRange（lib/analytics/metrics.ts:ANALYTICS_MAX_RANGE_DAYS）对超过 400 天的
 * 范围会**静默**把 start 往后挪，不报错。
 *
 * ⛔ 按月时一点「显示更多月」就是 24 个月 ≈ 730 天，直接撞上限：最老那个月只装了半个月的单，
 * 却顶着「2025 年 8 月」的完整标签显示 —— 一个看上去完全合理的错数字。
 * 所以这里自己先封顶，到顶就把按钮换成说明，不让用户点出一行假数据。
 */
const MAX_RANGE_DAYS = 400
/**
 * 本页全部面板统一按**送货日**（Order.deliveryDate，空则回落确认日）归集，
 * 见 lib/analytics/pivot.ts DATE_BASIS_EXPR。
 *
 * ⛔ 别改回默认的确认日：客户是"先送货、事后补录确认"的作业方式，实测 2026-09-13
 * 送货的 6 张单里有 3 张拖到 09-16 凌晨才确认，按确认日统计会把它们甩到下一周，
 * 页面上看就是"那天漏了一半的单"。毛利分析页/AI 问数仍是确认日口径，两页数字不等是预期的。
 */
const DATE_BASIS_QS = '&dateBasis=delivery'
/** 勾中的时间段行的高亮色，与右侧 DimensionPanel 的底色同一套 */
const SELECTED_BG = '#D1FAE5'

interface BucketRow {
  key: string
  name: string
  qty: number
  avgPrice: number
  revenueExTax: number
  totalIncTax: number
  grossProfit: number
}

interface BucketPayload {
  summary: { revenueExTax: number; totalIncTax: number; grossProfit: number }
  rows: BucketRow[]
}

/** 把周维度的 key（'2026-W31'，见 lib/analytics/pivot.ts DIMENSION_DEFS.week）换算回该 ISO 周的公历日期范围 */
function isoWeekRange(key: string): { from: string; to: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7))
  const dow = simple.getUTCDay() || 7
  const monday = new Date(simple)
  monday.setUTCDate(simple.getUTCDate() - dow + 1)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(monday), to: fmt(sunday) }
}

/** 把月维度的 key（'2026-09'，见 lib/analytics/pivot.ts DIMENSION_DEFS.month）换算回该月的公历日期范围 */
function monthRange(key: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const first = new Date(Date.UTC(year, month - 1, 1))
  const last = new Date(Date.UTC(year, month, 0))
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(first), to: fmt(last) }
}

/**
 * 取两个日期区间的交集。
 * ⛔ 月模式下展开周行时必须裁到月内：一个月的头尾两周是跨月的（ISO 周一~周日），
 * 而周行自己的合计是后端在「月」范围里算出来的（已裁过）。不裁的话展开出来的日行
 * 之和会大于它上面那行周合计，看上去就是"明细跟汇总对不上"。
 */
function intersectRange(a: { from: string; to: string }, b: { from: string; to: string } | null): { from: string; to: string } {
  if (!b) return a
  return { from: a.from > b.from ? a.from : b.from, to: a.to < b.to ? a.to : b.to }
}

/**
 * 把一个区间的右端裁到今天。
 *
 * ⛔ 勾选**当月/当周**时必须裁：左表那一行是用 `to = 今天` 拉的，而月/周的自然范围一直到月末/周日。
 * 不裁的话，今天下单、约定将来某天送的单（本页按送货日归集）会落进右面板却不在左表那行里，
 * 表现就是「右面板合计比紧挨着它的那一行还大」—— 跟 intersectRange 要防的是同一类毛病。
 */
function clampToToday(r: { from: string; to: string }): { from: string; to: string } {
  const today = fmtYMD(new Date())
  return { from: r.from, to: r.to > today ? today : r.to }
}

function mondayOf(d: Date): Date {
  const dow = d.getDay() || 7
  const m = new Date(d)
  m.setDate(d.getDate() - dow + 1)
  m.setHours(0, 0, 0, 0)
  return m
}

function fmtYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function weekLabel(key: string, isEn: boolean): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return key
  return isEn ? `W${m[2]} ${m[1]}` : `${m[1]} 年第 ${m[2]} 周`
}

/** 时间维度一律倒序（越近的月/周/日越靠上），屏幕与 CSV 导出同向 */
const sortDesc = (list: BucketRow[]) => [...list].sort((a, b) => b.key.localeCompare(a.key))

function monthLabel(key: string, isEn: boolean): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return key
  if (!isEn) return `${m[1]} 年 ${Number(m[2])} 月`
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  return `${d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} ${m[1]}`
}

function dayLabel(key: string, isEn: boolean): string {
  const d = new Date(`${key}T00:00:00`)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString(isEn ? 'en-GB' : 'zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })
}

export default function WeeklyDrilldown({ isEn, productIds = '', customerIds = '' }: { isEn: boolean; productIds?: string; customerIds?: string }) {
  // 顶层粒度：按周（原有，默认）或按月（20260920 加，钻取变三级 月→周→日）
  const [topLevel, setTopLevel] = useState<'week' | 'month'>('week')
  const [weeksBack, setWeeksBack] = useState(WEEKS_PAGE_SIZE)
  const [monthsBack, setMonthsBack] = useState(MONTHS_PAGE_SIZE)
  const [data, setData] = useState<BucketPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 顶层行的展开状态，key 是周 key 或月 key（取决于 topLevel） */
  const [expandedTop, setExpandedTop] = useState<Record<string, boolean>>({})
  /** 顶层行展开出来的子行：按周时是日行，按月时是周行 */
  const [childrenByTop, setChildrenByTop] = useState<Record<string, BucketRow[] | 'loading' | 'error'>>({})
  /** 月模式二级周行的展开状态与日明细。key 是 `${monthKey}|${weekKey}` ——
   *  跨月的那一周会同时挂在两个月下面，只用周 key 会串数据 */
  const [expandedWeek, setExpandedWeek] = useState<Record<string, boolean>>({})
  const [daysByWeek, setDaysByWeek] = useState<Record<string, BucketRow[] | 'loading' | 'error'>>({})
  /**
   * 20260920：勾选的时间段（月/周/日都可以，也可以混着勾）。右侧 DimensionPanel 按每段各自成组列出。
   * 取代了原来「一次只能点开一天的一个维度」的三个图标面板。
   */
  const [selections, setSelections] = useState<TimeSel[]>([])

  const extraFilterQs = DATE_BASIS_QS
    + (customerIds ? `&customerId=${encodeURIComponent(customerIds)}` : '')
    + (productIds ? `&productId=${encodeURIComponent(productIds)}` : '')

  const load = useCallback(() => {
    setError(null)
    const today = new Date()
    const rawFrom = topLevel === 'month'
      ? new Date(today.getFullYear(), today.getMonth() - (monthsBack - 1), 1)
      : new Date(mondayOf(today).getTime() - (weeksBack - 1) * 7 * 86400000)
    // 封顶到后端能接受的范围，超了它会悄悄截断，页面上看不出来
    const floor = new Date(today.getTime() - MAX_RANGE_DAYS * 86400000)
    const from = fmtYMD(rawFrom < floor ? floor : rawFrom)
    const to = fmtYMD(today)
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=${topLevel}&from=${from}&to=${to}${extraFilterQs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [topLevel, weeksBack, monthsBack, extraFilterQs])

  useEffect(() => { load() }, [load])

  // 产品/客户筛选或顶层粒度变了：之前展开/下钻的日、产品、司机、客户明细都是按旧筛选拉的，
  // 全部失效重置，避免面板里挂着一份跟当前筛选对不上的数据
  useEffect(() => {
    setExpandedTop({})
    setChildrenByTop({})
    setExpandedWeek({})
    setDaysByWeek({})
    setSelections([])
  }, [productIds, customerIds, topLevel])

  /** 勾选/取消一个时间段。月、周、日三层都能勾，也可以混着勾 */
  function toggleSelection(sel: TimeSel) {
    setSelections((prev) => prev.some((s) => s.key === sel.key)
      ? prev.filter((s) => s.key !== sel.key)
      : [...prev, sel])
  }

  /** 顶层行：按周时展开出日，按月时展开出周 */
  function toggleTop(row: BucketRow) {
    const willExpand = !expandedTop[row.key]
    setExpandedTop((prev) => ({ ...prev, [row.key]: willExpand }))
    if (!willExpand || childrenByTop[row.key]) return
    const range = topLevel === 'month' ? monthRange(row.key) : isoWeekRange(row.key)
    if (!range) return
    const childGroupBy = topLevel === 'month' ? 'week' : 'day'
    setChildrenByTop((prev) => ({ ...prev, [row.key]: 'loading' }))
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=${childGroupBy}&from=${range.from}&to=${range.to}${extraFilterQs}`)
      .then((payload) => setChildrenByTop((prev) => ({ ...prev, [row.key]: payload.rows })))
      .catch(() => setChildrenByTop((prev) => ({ ...prev, [row.key]: 'error' })))
  }

  /** 月模式下的二级周行：展开出这一周**落在该月内**的日（跨月部分归另一个月，见 intersectRange） */
  function toggleWeekRow(monthKey: string, weekKey: string) {
    const rowKey = `${monthKey}|${weekKey}`
    const willExpand = !expandedWeek[rowKey]
    setExpandedWeek((prev) => ({ ...prev, [rowKey]: willExpand }))
    if (!willExpand || daysByWeek[rowKey]) return
    const wr = isoWeekRange(weekKey)
    if (!wr) return
    const range = intersectRange(wr, monthRange(monthKey))
    setDaysByWeek((prev) => ({ ...prev, [rowKey]: 'loading' }))
    apiGet<BucketPayload>(`/api/analytics/margin?groupBy=day&from=${range.from}&to=${range.to}${extraFilterQs}`)
      .then((payload) => setDaysByWeek((prev) => ({ ...prev, [rowKey]: payload.rows })))
      .catch(() => setDaysByWeek((prev) => ({ ...prev, [rowKey]: 'error' })))
  }

  if (error) {
    return <div className="text-center text-red-500 py-16 text-sm">{error}</div>
  }
  if (!data) {
    return <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
  }

  // /api/analytics/margin 非透视分支按毛利降序排（给毛利分析页用），不是按时间——
  // 这里必须显式按 key（'YYYY-Www' / 'YYYY-MM-DD'）重排，不能假设 API 返回顺序。
  // 排序方向：倒序（越近的周/日越靠上），周内展开的日行同向，CSV 导出也跟屏幕一致
  const rowsDesc = sortDesc(data.rows)
  /** 再点一次「显示更多」就会超出 400 天上限 → 到顶，按钮换成说明 */
  const atRangeLimit = (() => {
    const today = new Date()
    const next = topLevel === 'month'
      ? new Date(today.getFullYear(), today.getMonth() - (monthsBack + MONTHS_PAGE_SIZE - 1), 1)
      : new Date(mondayOf(today).getTime() - (weeksBack + WEEKS_PAGE_SIZE - 1) * 7 * 86400000)
    return (today.getTime() - next.getTime()) / 86400000 > MAX_RANGE_DAYS
  })()
  // API 汇总(summary)不带 qty —— 总数量/总均价用各周行相加/推导，跟各行的 qty/avgPrice 口径一致
  const totalQty = rowsDesc.reduce((s, r) => s + r.qty, 0)
  const totalAvgPrice = totalQty > 0 ? data.summary.revenueExTax / totalQty : 0

  /**
   * 导出左边这张时间表当前**已经展开**的层级（总计 → 月 → 周 → 日），折叠的不导——
   * 跟屏幕上看到的保持一致，不额外发请求硬拉全量。
   * 右侧维度面板（司机/客户/产品…）有它自己的导出按钮，两张表结构不同，混在一个
   * 文件里只会让人对不上账。
   */
  function exportCsv() {
    if (!data) return
    const levelLabel = {
      total: isEn ? 'Total' : '总计', month: isEn ? 'Month' : '月', week: isEn ? 'Week' : '周', day: isEn ? 'Day' : '日',
    }
    const rows: string[][] = []
    const pushRow = (level: keyof typeof levelLabel, name: string, r: { qty?: number; avgPrice?: number; revenueExTax: number; totalIncTax: number; grossProfit: number }) =>
      rows.push([levelLabel[level], name, r.qty === undefined ? '' : String(r.qty), r.avgPrice === undefined ? '' : fmtMoney(r.avgPrice), fmtMoney(r.totalIncTax), fmtMoney(r.revenueExTax), fmtMoney(r.grossProfit)])

    const pushDay = (d: BucketRow) => pushRow('day', dayLabel(d.key, isEn), d)

    pushRow('total', levelLabel.total, data.summary)
    for (const top of rowsDesc) {
      pushRow(topLevel, topLevel === 'month' ? monthLabel(top.key, isEn) : weekLabel(top.key, isEn), top)
      const children = childrenByTop[top.key]
      if (!expandedTop[top.key] || !Array.isArray(children)) continue
      if (topLevel === 'week') {
        for (const d of sortDesc(children)) pushDay(d)
        continue
      }
      for (const w of sortDesc(children)) {
        pushRow('week', weekLabel(w.key, isEn), w)
        const rowKey = `${top.key}|${w.key}`
        const days = daysByWeek[rowKey]
        if (!expandedWeek[rowKey] || !Array.isArray(days)) continue
        for (const d of sortDesc(days)) pushDay(d)
      }
    }

    const headers = [isEn ? 'Level' : '层级', isEn ? 'Name' : '名称', isEn ? 'Qty' : '数量', isEn ? 'Avg Price' : '价格', isEn ? 'Total' : '总额', isEn ? 'Untaxed Total' : '未税总额', isEn ? 'Margin' : '毛利']
    downloadCsv(`sales-analysis-${topLevel === 'month' ? 'monthly' : 'weekly'}-${new Date().toISOString().slice(0, 10)}`, headers, rows)
  }

  /** 日行（钻取的最后一级）。按周时挂在周行下、按月时挂在周行下，缩进不同，其余完全一样 */
  /** 勾选框：月/周/日三层共用。stopPropagation 是必须的——行本身点了是展开时间层级 */
  function selectBox(sel: TimeSel) {
    const checked = selections.some((x) => x.key === sel.key)
    return (
      <input
        type="checkbox"
        checked={checked}
        onChange={() => toggleSelection(sel)}
        onClick={(e) => e.stopPropagation()}
        className="mr-2 align-middle accent-emerald-500 cursor-pointer"
        title={isEn ? 'Show this period in the panel on the right' : '在右侧面板里看这一段'}
      />
    )
  }

  /** 日行（时间轴最后一级）。20260920 起这里不再放三个维度图标，只有勾选框 */
  function renderDayRow(d: BucketRow, indentClass: string) {
    const sel: TimeSel = { key: `day:${d.key}`, label: dayLabel(d.key, isEn), from: d.key, to: d.key }
    const checked = selections.some((x) => x.key === sel.key)
    return (
      <tr
        key={d.key}
        className="border-b border-gray-50 text-gray-500"
        style={checked ? { background: SELECTED_BG } : undefined}
      >
        <td className={`${indentClass} py-1.5 whitespace-nowrap`}>
          {selectBox(sel)}
          {dayLabel(d.key, isEn)}
        </td>
        <td className="text-right px-3 py-1.5 tabular-nums">{Math.round(d.qty * 1000) / 1000}</td>
        <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.avgPrice)}</td>
        <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.totalIncTax)}</td>
        <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.revenueExTax)}</td>
        <td className="text-right px-3 py-1.5 tabular-nums">{eur(d.grossProfit)}</td>
      </tr>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* 顶层粒度：按周 = 周→日，按月 = 月→周→日 */}
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white">
            {(isEn
              ? [['week', 'Weekly'], ['month', 'Monthly']] as const
              : [['week', '按周'], ['month', '按月']] as const
            ).map(([g, label]) => (
              <button
                key={g}
                type="button"
                onClick={() => setTopLevel(g)}
                className="px-3 py-1 text-xs transition-colors"
                style={topLevel === g ? { background: PURPLE, color: 'white' } : { background: 'white', color: '#6b7280' }}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 口径标注：本页按送货日，毛利分析页按确认日，两页数字不等是预期的 */}
          <span className="text-xs text-gray-400">
            {isEn ? 'Grouped by delivery date' : '按送货日统计（订单确认日不同者以送货日为准）'}
          </span>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
          title={isEn ? 'Export the currently expanded rows (week/day/product/customer) as CSV' : '导出当前已展开的内容（周/日/产品/客户）为 CSV'}
        >
          ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
        </button>
      </div>
      <div className="flex flex-col lg:flex-row gap-4 items-start">
      <div className={(selections.length > 0 ? 'lg:w-[460px] lg:shrink-0 ' : 'flex-1 ') + 'bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden overflow-x-auto'}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-3 py-3 font-semibold text-gray-600">
              {topLevel === 'month' ? (isEn ? 'Month' : '月') : (isEn ? 'Week' : '周')}
            </th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Qty' : '数量'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Avg Price' : '价格'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Total' : '总额'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Untaxed Total' : '未税总额'}</th>
            <th className="text-right px-3 py-3 font-semibold text-gray-600">{isEn ? 'Margin' : '毛利'}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-gray-100 bg-gray-50 font-bold">
            <td className="px-3 py-2.5 text-gray-700">{isEn ? 'Total' : '总计'}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{Math.round(totalQty * 1000) / 1000}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(totalAvgPrice)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.totalIncTax)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.revenueExTax)}</td>
            <td className="text-right px-3 py-2.5 tabular-nums text-gray-900">{eur(data.summary.grossProfit)}</td>
          </tr>
          {rowsDesc.length === 0 && (
            <tr><td colSpan={6} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
          )}
          {rowsDesc.map((row) => {
            const isOpen = !!expandedTop[row.key]
            const children = childrenByTop[row.key]
            const topRange = topLevel === 'month' ? monthRange(row.key) : isoWeekRange(row.key)
            const topChecked = selections.some((x) => x.key === `${topLevel}:${row.key}`)
            return (
              <Fragment key={row.key}>
                <tr
                  className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                  style={topChecked ? { background: SELECTED_BG } : undefined}
                  onClick={() => toggleTop(row)}
                >
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="w-3 text-gray-400 inline-block" style={{ color: PURPLE }}>{isOpen ? '−' : '+'}</span>
                    {topRange && selectBox({
                      key: `${topLevel}:${row.key}`,
                      label: topLevel === 'month' ? monthLabel(row.key, isEn) : weekLabel(row.key, isEn),
                      ...clampToToday(topRange),
                    })}
                    {topLevel === 'month' ? monthLabel(row.key, isEn) : weekLabel(row.key, isEn)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{Math.round(row.qty * 1000) / 1000}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.avgPrice)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.totalIncTax)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.revenueExTax)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-800">{eur(row.grossProfit)}</td>
                </tr>
                {isOpen && children === 'loading' && (
                  <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                )}
                {isOpen && children === 'error' && (
                  <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                )}
                {/* 按月：顶层下面先是周行，点周行才展开到日；按周：顶层下面直接是日行 */}
                {isOpen && Array.isArray(children) && topLevel === 'month' && sortDesc(children).map((w) => {
                  const weekRowKey = `${row.key}|${w.key}`
                  const isWeekOpen = !!expandedWeek[weekRowKey]
                  const weekDays = daysByWeek[weekRowKey]
                  return (
                    <Fragment key={weekRowKey}>
                      <tr
                        className="border-b border-gray-50 text-gray-600 hover:bg-gray-50 cursor-pointer"
                        style={selections.some((x) => x.key === `week:${row.key}|${w.key}`) ? { background: SELECTED_BG } : undefined}
                        onClick={() => toggleWeekRow(row.key, w.key)}
                      >
                        <td className="pl-7 pr-3 py-2 whitespace-nowrap">
                          <span className="w-3 inline-block" style={{ color: PURPLE }}>{isWeekOpen ? '−' : '+'}</span>
                          {selectBox({
                            key: `week:${row.key}|${w.key}`,
                            label: weekLabel(w.key, isEn),
                            ...clampToToday(intersectRange(isoWeekRange(w.key) ?? { from: '', to: '' }, monthRange(row.key))),
                          })}
                          {weekLabel(w.key, isEn)}
                        </td>
                        <td className="text-right px-3 py-2 tabular-nums">{Math.round(w.qty * 1000) / 1000}</td>
                        <td className="text-right px-3 py-2 tabular-nums">{eur(w.avgPrice)}</td>
                        <td className="text-right px-3 py-2 tabular-nums">{eur(w.totalIncTax)}</td>
                        <td className="text-right px-3 py-2 tabular-nums">{eur(w.revenueExTax)}</td>
                        <td className="text-right px-3 py-2 tabular-nums">{eur(w.grossProfit)}</td>
                      </tr>
                      {isWeekOpen && weekDays === 'loading' && (
                        <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                      )}
                      {isWeekOpen && weekDays === 'error' && (
                        <tr><td colSpan={6} className="px-3 py-2 text-center text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                      )}
                      {isWeekOpen && Array.isArray(weekDays) && sortDesc(weekDays).map((d) => renderDayRow(d, 'pl-16 pr-5'))}
                    </Fragment>
                  )
                })}
                {isOpen && Array.isArray(children) && topLevel === 'week' && sortDesc(children).map((d) => renderDayRow(d, 'pl-10 pr-5'))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <div className="text-center py-3 border-t border-gray-50">
        {atRangeLimit ? (
          <span className="text-xs text-gray-400">
            {isEn
              ? `Reached the ${MAX_RANGE_DAYS}-day analysis limit — pick a narrower period to go further back.`
              : `已到分析范围上限（${MAX_RANGE_DAYS} 天），再往前看请换个时间段查`}
          </span>
        ) : (
          <button
            onClick={() => topLevel === 'month' ? setMonthsBack((n) => n + MONTHS_PAGE_SIZE) : setWeeksBack((n) => n + WEEKS_PAGE_SIZE)}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400"
          >
            {topLevel === 'month'
              ? (isEn ? 'Show more months' : '显示更多月')
              : (isEn ? 'Show more weeks' : '显示更多周')}
          </button>
        )}
      </div>
      </div>

      <div className="flex-1 min-w-0 w-full">
        <DimensionPanel
          isEn={isEn}
          selections={selections}
          baseQs={extraFilterQs}
          onRemove={(key) => setSelections((prev) => prev.filter((s) => s.key !== key))}
          onClearAll={() => setSelections([])}
        />
      </div>
      </div>
    </div>
  )
}
