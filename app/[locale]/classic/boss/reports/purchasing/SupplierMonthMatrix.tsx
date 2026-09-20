'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiPost } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import { bucketLabel } from '@/lib/reports/date-label'
import type { FilterSpec, ReportRequest } from '@/lib/reports/types'

/**
 * 采购分析：供应商（行）× 下单月份（列）
 * ============================================================================
 * 20260920，客户拿现网 Odoo 12 的 Purchase Analysis 截图提的：时间维度放横向、按月、
 * 供应商放左侧，「先只到月」。视觉与交互对齐 `boss/sales-analysis`（导航里的「销售分析」），
 * 两页在导航上并排，长得不一样会很突兀。
 *
 * 数据走已有的 `/api/reports/purchasing`（lib/reports/sql-builder.ts 那套白名单 SQL），
 * **不新开接口**：再写一条聚合路径，两处口径迟早跑偏。
 *
 * ⛔ 均价 = 金额 ÷ 数量（加权），在单元格 / 行合计 / 列合计 / 总计四层都是这么算的，
 * 因此"各列相加 == 行合计"这条恒等式处处成立。
 * 不用 `AVG(unit_cost)`：那是**采购行单价的算术平均**，一旦进了透视表的合计格就只能
 * 把若干个平均数再加起来，是个纯粹的假数。代价是与 Odoo 的 Average Price 口径不同
 * （Odoo 给的正是算术平均），同一格数字会不一样 —— 这是有意为之。
 */

/** 只统计已确认及之后的采购单。DRAFT/SENT/TO_APPROVE 还是询价阶段，不算采购。
 *  与「采购进货分析」页（app/api/analytics/procurement-analysis/pivot）同口径。 */
const COUNTED_STATUSES = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']

const PURPLE = '#875A7B'
/** 首列钉在左边。z 值要压过普通单元格，否则滚动时数字会盖在供应商名上面 */
const STICKY_HEAD = 'sticky left-0 z-20 bg-gray-50'
const STICKY_CELL = 'sticky left-0 z-10'
const MONTHS_PAGE_SIZE = 6
/** 一次取回的 供应商×月 组合数上限。超了会在表头挂告警，不静默截断 */
const ROW_LIMIT = 5000

type MeasureKey = 'amount' | 'qty' | 'avgPrice'

const MEASURE_LABELS: Record<MeasureKey, { zh: string; en: string }> = {
  amount:   { zh: '金额',  en: 'Amount' },
  qty:      { zh: '数量',  en: 'Qty' },
  avgPrice: { zh: '均价',  en: 'Avg Price' },
}

/** 结果集里的一行。日期维度的列名带粒度后缀（order_date + month → order_date_month），
 *  见 lib/reports/sql-builder.ts —— 读成 `order_date` 会恒为 undefined。 */
interface ApiRow {
  supplier_name?: string | null
  product_name?: string | null
  order_date_month: string | null
  subtotal_ex_tax: string | number | null
  ordered_qty: string | number | null
}

interface ApiResponse {
  rows: ApiRow[]
  totals: Record<string, number>
  total: number
}

/** 一个格子里的原始两个量。均价永远由这两个现推，不单独存 */
interface Cell { amount: number; qty: number }

const emptyCell = (): Cell => ({ amount: 0, qty: 0 })
const addInto = (acc: Cell, c: Cell) => { acc.amount += c.amount; acc.qty += c.qty }
const avgOf = (c: Cell) => (c.qty > 0 ? c.amount / c.qty : 0)

const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** 月份桶的起点（UTC 的当月 1 号），用作列 key。空值单独归到 '' 列 */
const monthKey = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return ''
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 7)
}

/** 从 'YYYY-MM' 还原成可给 bucketLabel 的日期 */
const monthDate = (key: string) => (key ? `${key}-01T00:00:00.000Z` : '')

/** 本页取数窗口：从 N 个月前的 1 号起，到今天（含）。用本地日历月切，跟用户看日历一致 */
function windowStart(monthsBack: number): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function SupplierMonthMatrix({
  isEn, supplierIds, productIds,
}: {
  isEn: boolean
  supplierIds: string[]
  productIds: string[]
}) {
  const [monthsBack, setMonthsBack] = useState(MONTHS_PAGE_SIZE)
  const [measures, setMeasures] = useState<MeasureKey[]>(['amount', 'qty', 'avgPrice'])
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * 展开到商品。key 是 `${scope}|${供应商名}` —— **scope 必须进 key**：
   * 换了筛选或时间窗口之后，旧的商品明细是按旧条件拉回来的，挂在同名供应商下面
   * 看起来就像是新条件的明细。把作用域编进 key，过期的那份自然找不到，
   * 不需要再拿一个 effect 去清空（清空 effect 还会多触发一轮渲染）。
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [productsBySupplier, setProductsBySupplier] = useState<
    Record<string, Array<{ name: string; cells: Map<string, Cell> }> | 'loading' | 'error'>
  >({})

  const supplierKey = supplierIds.join(',')
  const productKey = productIds.join(',')
  const scope = `${supplierKey}|${productKey}|${monthsBack}`
  const scoped = (name: string) => `${scope}|${name}`

  /** 行/列以外的固定筛选。下钻子请求必须原样带上，否则父子两行对不上账 */
  const baseFilters = useCallback((): FilterSpec[] => {
    const f: FilterSpec[] = [
      { field: 'order_date', operator: '>=', value: windowStart(monthsBack) },
      { field: 'po_status', operator: 'in', value: COUNTED_STATUSES },
    ]
    if (supplierIds.length) f.push({ field: 'supplier_id', operator: 'in', value: supplierIds })
    if (productIds.length) f.push({ field: 'product_id', operator: 'in', value: productIds })
    return f
  }, [monthsBack, supplierIds, productIds])

  useEffect(() => {
    let cancelled = false
    const body: ReportRequest = {
      rowDimensions: [{ field: 'supplier_name' }],
      colDimensions: [{ field: 'order_date', interval: 'month' }],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      filters: baseFilters(),
      limit: ROW_LIMIT,
    }
    apiPost<ApiResponse>('/api/reports/purchasing', body)
      .then((res) => { if (!cancelled) { setData(res); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [baseFilters])

  function toggleMeasure(m: MeasureKey) {
    setMeasures((prev) => {
      if (!prev.includes(m)) return (['amount', 'qty', 'avgPrice'] as MeasureKey[]).filter((k) => prev.includes(k) || k === m)
      if (prev.length === 1) return prev   // 至少留一个，否则表里只剩供应商名
      return prev.filter((k) => k !== m)
    })
  }

  function toggleSupplier(name: string) {
    const key = scoped(name)
    const willExpand = !expanded[key]
    setExpanded((prev) => ({ ...prev, [key]: willExpand }))
    if (!willExpand || productsBySupplier[key]) return

    setProductsBySupplier((prev) => ({ ...prev, [key]: 'loading' }))
    const body: ReportRequest = {
      rowDimensions: [{ field: 'product_name' }],
      colDimensions: [{ field: 'order_date', interval: 'month' }],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      // 把这一行锁死成筛选条件 —— 这样"商品行各列之和 == 供应商行对应列"天然成立
      filters: [...baseFilters(), { field: 'supplier_name', operator: '=', value: name }],
      limit: ROW_LIMIT,
    }
    apiPost<ApiResponse>('/api/reports/purchasing', body)
      .then((res) => {
        const byProduct = new Map<string, Map<string, Cell>>()
        for (const r of res.rows) {
          const pname = r.product_name ?? '—'
          if (!byProduct.has(pname)) byProduct.set(pname, new Map())
          const cells = byProduct.get(pname)!
          const mk = monthKey(r.order_date_month)
          if (!cells.has(mk)) cells.set(mk, emptyCell())
          addInto(cells.get(mk)!, { amount: num(r.subtotal_ex_tax), qty: num(r.ordered_qty) })
        }
        const list = Array.from(byProduct.entries())
          .map(([name2, cells]) => ({ name: name2, cells }))
          .sort((a, b) => totalOf(b.cells).amount - totalOf(a.cells).amount)
        setProductsBySupplier((prev) => ({ ...prev, [key]: list }))
      })
      .catch(() => setProductsBySupplier((prev) => ({ ...prev, [key]: 'error' })))
  }

  if (error) return <div className="text-center text-red-500 py-16 text-sm">{error}</div>
  if (!data) return <div className="text-center text-gray-400 py-16 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>

  // ── 把扁平结果集折成 供应商 → 月 → 格子 ────────────────────────────────────
  const monthSet = new Set<string>()
  const bySupplier = new Map<string, Map<string, Cell>>()
  for (const r of data.rows) {
    const sname = r.supplier_name ?? (isEn ? '(no supplier)' : '（无供应商）')
    const mk = monthKey(r.order_date_month)
    monthSet.add(mk)
    if (!bySupplier.has(sname)) bySupplier.set(sname, new Map())
    const cells = bySupplier.get(sname)!
    if (!cells.has(mk)) cells.set(mk, emptyCell())
    addInto(cells.get(mk)!, { amount: num(r.subtotal_ex_tax), qty: num(r.ordered_qty) })
  }

  // 列序：月份升序（老的在左、新的在右），与 Odoo 一致；合计列恒在最右
  const months = Array.from(monthSet).sort((a, b) => a.localeCompare(b))
  // 行序：按期间总金额倒序 —— 老板先看的永远是花钱最多的那几家
  const suppliers = Array.from(bySupplier.entries())
    .map(([name, cells]) => ({ name, cells }))
    .sort((a, b) => totalOf(b.cells).amount - totalOf(a.cells).amount)

  const colTotals = new Map<string, Cell>()
  months.forEach((m) => colTotals.set(m, emptyCell()))
  bySupplier.forEach((cells) => {
    cells.forEach((c, m) => addInto(colTotals.get(m)!, c))
  })

  // 总计格用后端不带 limit 的 totals，不是把上面各列加一遍 ——
  // 结果集被截断时，只有这个数字仍然是对的，两者不等正是截断的证据
  const grand: Cell = { amount: num(data.totals?.subtotal_ex_tax), qty: num(data.totals?.ordered_qty) }
  const truncated = data.rows.length >= ROW_LIMIT || data.rows.length < (data.total ?? 0)

  const colSpanPerMonth = measures.length
  const totalCols = 1 + (months.length + 1) * colSpanPerMonth

  function cellFor(cells: Map<string, Cell>, m: string): Cell | undefined { return cells.get(m) }

  /** 一行里的数字格：每个月一组，最后再来一组合计 */
  function measureCells(cells: Map<string, Cell>, keyPrefix: string, cls: string) {
    const out: React.ReactNode[] = []
    for (const m of months) {
      const c = cellFor(cells, m)
      for (const k of measures) {
        out.push(
          <td key={`${keyPrefix}|${m}|${k}`} className={`text-right px-3 ${cls} tabular-nums whitespace-nowrap`}>
            {c ? renderMeasure(c, k) : <span className="text-gray-300">—</span>}
          </td>,
        )
      }
    }
    const t = totalOf(cells)
    for (const k of measures) {
      out.push(
        <td key={`${keyPrefix}|total|${k}`} className={`text-right px-3 ${cls} tabular-nums whitespace-nowrap bg-gray-50/70`}>
          {renderMeasure(t, k)}
        </td>,
      )
    }
    return out
  }

  function renderMeasure(c: Cell, k: MeasureKey) {
    if (k === 'amount') return eur(c.amount)
    if (k === 'qty') return Math.round(c.qty * 1000) / 1000
    return eur(avgOf(c))
  }

  function exportCsv() {
    const headers = [isEn ? 'Supplier' : '供应商']
    for (const m of months) {
      const label = bucketLabel(monthDate(m), 'month', isEn)
      for (const k of measures) headers.push(`${label} · ${isEn ? MEASURE_LABELS[k].en : MEASURE_LABELS[k].zh}`)
    }
    for (const k of measures) headers.push(`${isEn ? 'Total' : '合计'} · ${isEn ? MEASURE_LABELS[k].en : MEASURE_LABELS[k].zh}`)

    const line = (name: string, cells: Map<string, Cell>) => {
      const row: string[] = [name]
      const push = (c: Cell | undefined) => {
        for (const k of measures) {
          if (!c) { row.push(''); continue }
          row.push(k === 'qty' ? String(Math.round(c.qty * 1000) / 1000) : fmtMoney(k === 'amount' ? c.amount : avgOf(c)))
        }
      }
      for (const m of months) push(cellFor(cells, m))
      push(totalOf(cells))
      return row
    }

    const rows: string[][] = []
    // 总计行用后端全量 totals，跟屏幕上那一行一致
    const totalCells = new Map(months.map((m) => [m, colTotals.get(m)!]))
    const totalRow = line(isEn ? 'Total' : '总计', totalCells)
    // 合计那几格改用 grand（不受 limit 影响）
    for (let i = 0; i < measures.length; i++) {
      const k = measures[measures.length - 1 - i]
      totalRow[totalRow.length - 1 - i] = k === 'qty'
        ? String(Math.round(grand.qty * 1000) / 1000)
        : fmtMoney(k === 'amount' ? grand.amount : avgOf(grand))
    }
    rows.push(totalRow)

    // 只导出屏幕上看得到的：展开了的供应商，跟着导出它的商品明细
    for (const s of suppliers) {
      rows.push(line(s.name, s.cells))
      const kids = productsBySupplier[scoped(s.name)]
      if (!expanded[scoped(s.name)] || !Array.isArray(kids)) continue
      for (const p of kids) rows.push(line(`    ${p.name}`, p.cells))
    }

    downloadCsv(`purchase-analysis-monthly-${new Date().toISOString().slice(0, 10)}`, headers, rows)
  }

  return (
    <div>
      {/* ── 表格上方那一条：度量开关 · 口径说明 · 导出 ─────────────────────── */}
      <div className="flex justify-between items-center gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white">
            {(['amount', 'qty', 'avgPrice'] as MeasureKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => toggleMeasure(k)}
                className="px-3 py-1 text-xs transition-colors"
                style={measures.includes(k) ? { background: PURPLE, color: 'white' } : { background: 'white', color: '#6b7280' }}
              >
                {isEn ? MEASURE_LABELS[k].en : MEASURE_LABELS[k].zh}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {isEn
              ? 'By order date · confirmed POs and later only · avg price = amount ÷ qty'
              : '按下单日期统计 · 只计已确认及之后的采购单 · 均价 = 金额 ÷ 数量'}
          </span>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-gray-400 bg-white"
          title={isEn ? 'Export what is on screen, including expanded products' : '导出当前屏幕上的内容（含已展开的商品明细）'}
        >
          ⬇ {isEn ? 'Download CSV' : '下载 CSV'}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden overflow-x-auto">
        {truncated && (
          <div className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-b border-amber-100">
            {isEn
              ? `Too many supplier×month combinations (${data.total}), showing the first ${data.rows.length}. Column subtotals below are therefore incomplete — narrow the filters or shorten the period. The grand total on the right is still the full figure.`
              : `供应商×月的组合太多（共 ${data.total} 条，只取回前 ${data.rows.length} 条）。下面各列的小计因此是不完整的——请缩小筛选范围或缩短时间段。最右侧的合计仍是全量数字。`}
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            {/* 第一行：月份（跨 measures 列）+ 最右的合计 */}
            <tr className="border-b border-gray-100 bg-gray-50">
              {/* 首列钉住：月份多了之后表格必然横向滚动，供应商名跟着滚走的话
                  右边那一堆数字就不知道是谁的了 */}
              <th rowSpan={2} className={`text-left px-3 py-3 font-semibold text-gray-600 align-bottom whitespace-nowrap ${STICKY_HEAD}`}>
                {isEn ? 'Supplier' : '供应商'}
              </th>
              {months.map((m) => (
                <th key={m} colSpan={colSpanPerMonth} className="text-center px-3 py-2 font-semibold text-gray-600 border-l border-gray-100 whitespace-nowrap">
                  {m ? bucketLabel(monthDate(m), 'month', isEn) : (isEn ? '(no date)' : '（无日期）')}
                </th>
              ))}
              <th colSpan={colSpanPerMonth} className="text-center px-3 py-2 font-semibold text-gray-700 border-l border-gray-200 bg-gray-100/70 whitespace-nowrap">
                {isEn ? 'Total' : '合计'}
              </th>
            </tr>
            {/* 第二行：每个月下面的度量名 */}
            <tr className="border-b border-gray-100 bg-gray-50">
              {months.flatMap((m) => measures.map((k, i) => (
                <th
                  key={`${m}|${k}`}
                  className={`text-right px-3 pb-2 text-xs font-medium text-gray-400 whitespace-nowrap ${i === 0 ? 'border-l border-gray-100' : ''}`}
                >
                  {isEn ? MEASURE_LABELS[k].en : MEASURE_LABELS[k].zh}
                </th>
              )))}
              {measures.map((k, i) => (
                <th
                  key={`t|${k}`}
                  className={`text-right px-3 pb-2 text-xs font-medium text-gray-500 bg-gray-100/70 whitespace-nowrap ${i === 0 ? 'border-l border-gray-200' : ''}`}
                >
                  {isEn ? MEASURE_LABELS[k].en : MEASURE_LABELS[k].zh}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 总计行置顶，与销售分析一致 */}
            <tr className="border-b border-gray-100 bg-gray-50 font-bold">
              <td className={`px-3 py-2.5 text-gray-700 whitespace-nowrap ${STICKY_CELL} bg-gray-50`}>{isEn ? 'Total' : '总计'}</td>
              {months.flatMap((m) => {
                const c = colTotals.get(m)!
                return measures.map((k) => (
                  <td key={`gt|${m}|${k}`} className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap">
                    {renderMeasure(c, k)}
                  </td>
                ))
              })}
              {measures.map((k) => (
                <td key={`gt|total|${k}`} className="text-right px-3 py-2.5 tabular-nums text-gray-900 whitespace-nowrap bg-gray-100/70">
                  {renderMeasure(grand, k)}
                </td>
              ))}
            </tr>

            {suppliers.length === 0 && (
              <tr><td colSpan={totalCols} className="text-center py-16 text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
            )}

            {suppliers.map((s) => {
              const isOpen = !!expanded[scoped(s.name)]
              const kids = productsBySupplier[scoped(s.name)]
              return (
                <Fragment key={s.name}>
                  <tr className="group border-b border-gray-50 hover:bg-gray-50 cursor-pointer" onClick={() => toggleSupplier(s.name)}>
                    <td className={`px-3 py-2.5 whitespace-nowrap text-gray-800 ${STICKY_CELL} bg-white group-hover:bg-gray-50`}>
                      <span className="w-3 inline-block" style={{ color: PURPLE }}>{isOpen ? '−' : '+'}</span>
                      {s.name}
                    </td>
                    {measureCells(s.cells, s.name, 'py-2.5 text-gray-800')}
                  </tr>
                  {isOpen && kids === 'loading' && (
                    <tr><td colSpan={totalCols} className="px-3 py-2 text-center text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                  )}
                  {isOpen && kids === 'error' && (
                    <tr><td colSpan={totalCols} className="px-3 py-2 text-center text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                  )}
                  {isOpen && Array.isArray(kids) && kids.length === 0 && (
                    <tr><td colSpan={totalCols} className="px-3 py-2 text-center text-xs text-gray-400">{isEn ? 'No products' : '这家供应商下面没有商品明细'}</td></tr>
                  )}
                  {isOpen && Array.isArray(kids) && kids.map((p) => (
                    <tr key={`${s.name}|${p.name}`} className="border-b border-gray-50 text-gray-500">
                      <td className={`pl-10 pr-3 py-1.5 whitespace-nowrap ${STICKY_CELL} bg-white`}>{p.name}</td>
                      {measureCells(p.cells, `${s.name}|${p.name}`, 'py-1.5')}
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        <div className="text-center py-3 border-t border-gray-50">
          <button
            onClick={() => setMonthsBack((n) => n + MONTHS_PAGE_SIZE)}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400"
          >
            {isEn ? 'Show more months' : '显示更多月'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 一行所有月份加总。金额和数量各自相加，均价永远从这两个和现推 */
function totalOf(cells: Map<string, Cell>): Cell {
  const t = emptyCell()
  cells.forEach((c) => addInto(t, c))
  return t
}
