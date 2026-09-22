'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { eur, fmtMoney } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'

/**
 * 销售钻取页右侧的「维度面板」（20260920）
 * ============================================================================
 * 取代原来挂在日期行左边的三个图标 ▤👥🚚 —— 那套一个维度一个图标，维度加到第四个
 * 就把日期挤没了，而且只能作用在「日」这一层。
 *
 * 现在：左表勾选一个或多个时间段（月/周/日都行），这里按**每个时间段各自成组**列出，
 * 组内按顶部标签选的维度作为第一层，再往下按固定顺序嵌套（见 DIM_CHAIN）。
 * 客户批注原话：「先按照客户展开，再按照产品展开」「展开顺序按照 司机 客户 产品」。
 */

export type TimeSel = { key: string; label: string; from: string; to: string }
export type PanelDim = 'driver' | 'customer' | 'product' | 'salesUser' | 'category'

interface DimRow {
  key: string
  name: string
  qty: number
  avgPrice: number
  revenueExTax: number
  totalIncTax: number
  grossProfit: number
  grossWeight: number
  commission: number
  /** 只有产品维度有值；同一商品既按 CASE 又按 KG 卖时是「CASE, KG」（生产实测 5.54% 的产品×天分组是这样） */
  uomNames?: string | null
}
interface DimPayload {
  summary: { revenueExTax: number; totalIncTax: number; grossProfit: number; grossWeight: number; commission: number; weightCoverageRate: number }
  rows: DimRow[]
}

/**
 * 每个标签往下的嵌套顺序。客户定的主链是 司机 › 客户 › 产品，
 * 从哪个标签进去就从链上那一节开始往下走。
 * product 是链的末端，但「某产品卖给了哪些客户」是 20260915 起就有、客户一直在用的
 * 查账路径，所以单独给它接一节 customer，不要因为"链上没有"就砍掉。
 */
const DIM_CHAIN: Record<PanelDim, string[]> = {
  driver: ['driver', 'customer', 'product'],
  customer: ['customer', 'product'],
  product: ['product', 'customer'],
  salesUser: ['salesUser', 'customer', 'product'],
  category: ['category', 'product'],
}

/** 维度 → margin API 的筛选参数名。driver 没有稳定 id，用司机名筛（见 pivot.ts driver 维度注释） */
const FILTER_PARAM: Record<string, string> = {
  product: 'productId',
  customer: 'customerId',
  driver: 'driverName',
  salesUser: 'salesUserId',
  category: 'categoryId',
}

const DIM_LABEL: Record<string, { zh: string; en: string }> = {
  driver: { zh: '司机', en: 'Driver' },
  customer: { zh: '客户', en: 'Customer' },
  product: { zh: '产品', en: 'Product' },
  salesUser: { zh: '业务员', en: 'Salesperson' },
  category: { zh: '品类', en: 'Category' },
}

const TABS: PanelDim[] = ['driver', 'customer', 'product', 'salesUser', 'category']

const GREEN_BG = '#D1FAE5'
const GREEN_BORDER = '#34D399'
const PURPLE = '#875A7B'

type NodeState = DimRow[] | 'loading' | 'error'

type SortKey = 'name' | 'uom' | 'qty' | 'avgPrice' | 'totalIncTax' | 'revenueExTax' | 'grossProfit' | 'grossWeight' | 'commission'

/**
 * 面板的列。表头、排序、单元格、CSV 都读这一份，改列只改这里。
 * ⛔ 排序是**前端**排的：每一层的行已经整层拿在手里了（后端按维度聚合、没有分页），
 * 就地排不用再发请求；也因此排序对**每一层**都生效，展开的子层跟着父层同一套规则排。
 */
const COLUMNS: Array<{ key: SortKey; zh: string; en: string; num: boolean; fmt: (r: DimRow) => string }> = [
  { key: 'name', zh: '', en: '', num: false, fmt: (r) => r.name },
  // 20260920 客户要求：产品后面要看到单位。只有产品那一层有值，其余层留空
  { key: 'uom', zh: '单位', en: 'Unit', num: false, fmt: (r) => r.uomNames ?? '' },
  { key: 'qty', zh: '数量', en: 'Qty', num: true, fmt: (r) => String(Math.round(r.qty * 1000) / 1000) },
  // 20260921 客户截图要求：加一列单价（= 总额÷数量的加权均价，口径与左表「价格」列一致）
  { key: 'avgPrice', zh: '单价', en: 'Unit Price', num: true, fmt: (r) => eur(r.avgPrice) },
  { key: 'totalIncTax', zh: '总额', en: 'Total', num: true, fmt: (r) => eur(r.totalIncTax) },
  { key: 'revenueExTax', zh: '未税', en: 'Untaxed', num: true, fmt: (r) => eur(r.revenueExTax) },
  { key: 'grossProfit', zh: '毛利', en: 'Margin', num: true, fmt: (r) => eur(r.grossProfit) },
  { key: 'grossWeight', zh: '毛重', en: 'Gross Wt.', num: true, fmt: (r) => String(Math.round(r.grossWeight * 100) / 100) },
  { key: 'commission', zh: '提成', en: 'Commission', num: true, fmt: (r) => eur(r.commission) },
]

/**
 * 树节点的唯一路径：`标签维度@时间段key§维度:key§…`，祖先链一眼可读，也是取数的缓存键。
 *
 * ⛔ 开头那个 `dim`（当前标签页）不能省。省掉的话根节点的 key 对每个标签都是同一个
 * `sel.key`：从「司机」快速切到「客户」时，司机那次请求还在路上，回来后照样写进
 * `nodes[sel.key]` —— 谁后到谁赢。结果是「客户」表头下面列着司机名，再往下点会拿
 * 司机名去当 customerId 查。带上 dim 之后两个标签各写各的格子，晚到的响应落在
 * 自己那把钥匙上，不会覆盖别人。
 */
function pathOf(dim: PanelDim, selKey: string, chain: Array<{ dim: string; key: string }>): string {
  return [`${dim}@${selKey}`, ...chain.map((c) => `${c.dim}:${c.key}`)].join('§')
}

export default function DimensionPanel({
  isEn,
  selections,
  baseQs,
  onRemove,
  onClearAll,
}: {
  isEn: boolean
  selections: TimeSel[]
  /** 页面级筛选（产品/客户多选）+ dateBasis，原样透传给每一次取数 */
  baseQs: string
  onRemove: (key: string) => void
  onClearAll: () => void
}) {
  const [dim, setDim] = useState<PanelDim>('driver')
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  /** 收起某个时间段整组 */
  const [groupClosed, setGroupClosed] = useState<Record<string, boolean>>({})
  /**
   * 排序。默认总额降序 —— 后端 margin 路由是按**毛利**降序返回的（那是毛利分析页要的），
   * 而这个面板回答的是「谁买得多/谁卖得多」，按总额更顺手。
   */
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'totalIncTax', dir: 'desc' })

  const sortRows = useCallback((rows: DimRow[]) => {
    const m = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      if (sort.key === 'name') return m * a.name.localeCompare(b.name, isEn ? 'en' : 'zh')
      if (sort.key === 'uom') return m * (a.uomNames ?? '').localeCompare(b.uomNames ?? '', isEn ? 'en' : 'zh')
      return m * ((a[sort.key] as number) - (b[sort.key] as number))
    })
  }, [sort, isEn])

  /** 点表头：换列时用降序起步（看排行榜都是想先看最大的），同一列再点是反向 */
  function toggleSort(key: SortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'name' || key === 'uom' ? 'asc' : 'desc' })
  }

  const label = useCallback((d: string) => (isEn ? DIM_LABEL[d].en : DIM_LABEL[d].zh), [isEn])

  const fetchNode = useCallback((sel: TimeSel, ancestors: Array<{ dim: string; key: string }>) => {
    const chain = DIM_CHAIN[dim]
    const depth = ancestors.length
    const groupBy = chain[depth]
    if (!groupBy) return
    const path = pathOf(dim, sel.key, ancestors)
    setNodes((prev) => (prev[path] ? prev : { ...prev, [path]: 'loading' }))
    const qs = new URLSearchParams({ groupBy, from: sel.from, to: sel.to })
    for (const a of ancestors) qs.set(FILTER_PARAM[a.dim], a.key)
    apiGet<DimPayload>(`/api/analytics/margin?${qs.toString()}${baseQs}`)
      .then((p) => setNodes((prev) => ({ ...prev, [path]: p.rows })))
      .catch(() => setNodes((prev) => ({ ...prev, [path]: 'error' })))
  }, [dim, baseQs])

  /**
   * 维度或页面筛选变了：整棵树按旧条件拉的，作废重来。
   *
   * ⛔ 清空和重拉必须在**同一个** effect 里。分成两个（一个 setNodes({})、
   * 另一个「没有就补拉」）会互相错过：同一轮 render 后两个 effect 依次执行，
   * 补拉那个读到的 nodes 还是清空**前**的闭包值，于是判定"已经有数据了"而不去拉；
   * 等清空真正生效再 render 时，它的依赖又没变、不会再跑 —— 结果就是换个标签页面板全空。
   * 实测踩过，别再拆开。
   */
  useEffect(() => {
    setNodes({})
    setOpen({})
    for (const sel of selections) fetchNode(sel, [])
    // selections 的增减由下面那个 effect 负责，这里只认维度/筛选的变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim, baseQs])

  // 新勾选的时间段，进来就把第一层拉出来（不用再点一次）
  useEffect(() => {
    for (const sel of selections) {
      const path = pathOf(dim, sel.key, [])
      if (!nodes[path]) fetchNode(sel, [])
    }
    // nodes 变化不该触发重取，否则每拉一层就重跑一轮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selections])

  function toggleNode(sel: TimeSel, ancestors: Array<{ dim: string; key: string }>, row: DimRow) {
    const next = [...ancestors, { dim: DIM_CHAIN[dim][ancestors.length], key: row.key }]
    const path = pathOf(dim, sel.key, next)
    const willOpen = !open[path]
    setOpen((prev) => ({ ...prev, [path]: willOpen }))
    if (willOpen && !nodes[path]) fetchNode(sel, next)
  }

  /**
   * 导出面板里**已经展开**的那棵树（每个时间段一段，层级写在第一列），折叠的不导。
   * 跟左表的 CSV 分开两个文件：两张表的列不一样，合在一起对不上账。
   */
  function exportPanelCsv() {
    const chain = DIM_CHAIN[dim]
    const rows: string[][] = []
    const walk = (sel: TimeSel, ancestors: Array<{ dim: string; key: string }>, list: DimRow[]) => {
      for (const r of sortRows(list)) {
        const depth = ancestors.length
        rows.push([
          sel.label, label(chain[depth]), '  '.repeat(depth) + r.name, r.uomNames ?? '',
          String(Math.round(r.qty * 1000) / 1000), fmtMoney(r.avgPrice), fmtMoney(r.totalIncTax), fmtMoney(r.revenueExTax),
          fmtMoney(r.grossProfit), String(Math.round(r.grossWeight * 100) / 100), fmtMoney(r.commission),
        ])
        const next = [...ancestors, { dim: chain[depth], key: r.key }]
        const childPath = pathOf(dim, sel.key, next)
        const child = nodes[childPath]
        if (open[childPath] && Array.isArray(child)) walk(sel, next, child)
      }
    }
    for (const sel of selections) {
      const root = nodes[pathOf(dim, sel.key, [])]
      if (Array.isArray(root)) walk(sel, [], root)
    }
    const headers = isEn
      ? ['Period', 'Level', 'Name', 'Unit', 'Qty', 'Unit Price', 'Total', 'Untaxed', 'Margin', 'Gross Weight', 'Commission']
      : ['时间段', '层级', '名称', '单位', '数量', '单价', '总额', '未税', '毛利', '毛重', '提成']
    downloadCsv(`sales-analysis-${dim}-${new Date().toISOString().slice(0, 10)}`, headers, rows)
  }

  if (selections.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="px-5 py-14 text-center text-sm text-gray-400 leading-7">
          {isEn ? (
            <>Tick one or more rows on the left<br />(month, week or day — you can mix them)<br />and they all show up here, each in its own block.</>
          ) : (
            <>在左边勾选一行或多行<br />（月、周、日都行，也可以混着勾）<br />勾中的每一段都会在这里单独成一块</>
          )}
        </div>
      </div>
    )
  }

  const colCount = COLUMNS.length

  return (
    <div className="rounded-xl shadow-sm overflow-hidden border" style={{ background: GREEN_BG, borderColor: GREEN_BORDER }}>
      {/* ── 头部：选了哪几段 + 维度标签页 ─────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-700 mb-1.5">
            {isEn ? `${selections.length} period(s) selected` : `已选 ${selections.length} 段时间`}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selections.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1 text-xs bg-white/75 rounded-full pl-2.5 pr-1 py-0.5 text-gray-700">
                {s.label}
                <button
                  type="button"
                  onClick={() => onRemove(s.key)}
                  className="w-4 h-4 rounded-full text-gray-400 hover:text-gray-700 hover:bg-black/5 leading-none text-[11px]"
                  title={isEn ? 'Remove' : '取消这一段'}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
        <button type="button" onClick={onClearAll} className="text-gray-400 hover:text-gray-600 text-sm px-1 shrink-0" title={isEn ? 'Clear all' : '全部取消'}>
          ✕
        </button>
      </div>

      <div className="px-4 pb-2.5 flex flex-wrap items-center gap-1.5">
        {TABS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDim(d)}
            className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
            style={d === dim
              ? { background: 'white', borderColor: 'rgba(0,0,0,.16)', color: '#111827', fontWeight: 600 }
              : { background: 'rgba(255,255,255,.55)', borderColor: 'rgba(0,0,0,.08)', color: '#4b5563' }}
          >
            {label(d)}
          </button>
        ))}
        <span className="text-[11px] text-gray-500 ml-1">
          {isEn ? `drill: ${DIM_CHAIN[dim].map(label).join(' › ')}` : `展开顺序：${DIM_CHAIN[dim].map(label).join(' › ')}`}
        </span>
        <button
          type="button"
          onClick={exportPanelCsv}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg border bg-white/70 text-gray-600 hover:bg-white"
          style={{ borderColor: 'rgba(0,0,0,.1)' }}
          title={isEn ? 'Export what is expanded here' : '导出这里已展开的内容'}
        >
          ⬇ CSV
        </button>
      </div>

      {/* ── 每个时间段一块 ─────────────────────────────────────────── */}
      <div className="max-h-[720px] overflow-y-auto">
        {selections.map((sel) => {
          const rootPath = pathOf(dim, sel.key, [])
          const rootRows = nodes[rootPath]
          const closed = !!groupClosed[sel.key]
          return (
            <div key={sel.key} className="border-t" style={{ borderColor: 'rgba(0,0,0,.07)' }}>
              <button
                type="button"
                onClick={() => setGroupClosed((p) => ({ ...p, [sel.key]: !closed }))}
                className="w-full text-left px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-white/40 flex items-center gap-2"
              >
                <span style={{ color: PURPLE }}>{closed ? '▸' : '▾'}</span>
                {sel.label}
                <span className="font-normal text-gray-500">
                  {Array.isArray(rootRows) ? `· ${rootRows.length} ${isEn ? 'rows' : '行'}` : ''}
                </span>
              </button>
              {!closed && (
                <div className="overflow-x-auto">
                <table className="w-full text-[13px]" style={{ background: 'rgba(255,255,255,.55)', minWidth: 800 }}>
                  <thead>
                    <tr className="border-b" style={{ borderColor: 'rgba(0,0,0,.07)' }}>
                      {COLUMNS.map((c) => {
                        const active = sort.key === c.key
                        const text = c.key === 'name' ? label(DIM_CHAIN[dim][0]) : (isEn ? c.en : c.zh)
                        return (
                          <th
                            key={c.key}
                            onClick={() => toggleSort(c.key)}
                            className={`${c.num ? 'text-right px-2.5' : 'text-left px-4'} py-1.5 font-semibold cursor-pointer select-none whitespace-nowrap hover:bg-black/[.04]`}
                            style={{ color: active ? PURPLE : '#4b5563' }}
                            title={isEn ? 'Click to sort (applies to every level)' : '点击排序（每一层都按这个排）'}
                          >
                            {text}
                            <span className="ml-0.5 text-[10px]">{active ? (sort.dir === 'desc' ? '▼' : '▲') : '⇅'}</span>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rootRows === 'loading' && (
                      <tr><td colSpan={colCount} className="text-center py-6 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
                    )}
                    {rootRows === 'error' && (
                      <tr><td colSpan={colCount} className="text-center py-6 text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
                    )}
                    {Array.isArray(rootRows) && rootRows.length === 0 && (
                      <tr><td colSpan={colCount} className="text-center py-6 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
                    )}
                    {Array.isArray(rootRows) && sortRows(rootRows).map((row) => (
                      <TreeRows
                        key={row.key}
                        sel={sel}
                        row={row}
                        ancestors={[]}
                        dim={dim}
                        nodes={nodes}
                        open={open}
                        isEn={isEn}
                        label={label}
                        sortRows={sortRows}
                        onToggle={toggleNode}
                      />
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 毛重这列在生产上只覆盖 74.3% 的金额，不写出来就等于骗人 */}
      <div className="px-4 py-2 text-[11px] text-gray-500 border-t" style={{ borderColor: 'rgba(0,0,0,.07)' }}>
        {isEn
          ? 'Gross weight falls back to the product base weight when the sale unit has none; lines with neither are counted as 0, so the weight total reads low.'
          : '毛重优先取可售单位重量，没有的用商品基础重量兜底；两者都没有的行按 0 计，所以毛重合计偏低。'}
      </div>
    </div>
  )
}

/** 一行 + 它展开后的所有后代（递归） */
function TreeRows({
  sel, row, ancestors, dim, nodes, open, isEn, label, sortRows, onToggle,
}: {
  sel: TimeSel
  row: DimRow
  ancestors: Array<{ dim: string; key: string }>
  dim: PanelDim
  nodes: Record<string, NodeState>
  open: Record<string, boolean>
  isEn: boolean
  label: (d: string) => string
  sortRows: (rows: DimRow[]) => DimRow[]
  onToggle: (sel: TimeSel, ancestors: Array<{ dim: string; key: string }>, row: DimRow) => void
}) {
  const chain = DIM_CHAIN[dim]
  const depth = ancestors.length
  const myDim = chain[depth]
  const next = [...ancestors, { dim: myDim, key: row.key }]
  const path = pathOf(dim, sel.key, next)
  const hasChild = depth + 1 < chain.length
  const isOpen = !!open[path]
  const childRows = nodes[path]

  return (
    <Fragment>
      <tr
        className={`border-b ${hasChild ? 'cursor-pointer hover:bg-black/[.03]' : ''}`}
        style={{ borderColor: 'rgba(0,0,0,.05)' }}
        onClick={hasChild ? () => onToggle(sel, ancestors, row) : undefined}
      >
        {/* ⛔ 名称必须截断：商品名动辄 40 多个字符（"CN Ham Tan(salted cooked egg) 24*6pcs CASE"），
            不截断会把整行撑成五六行高，一屏看不了几条。全名挂 title 上。 */}
        <td className="py-1.5 pr-3 text-gray-700" style={{ paddingLeft: 16 + depth * 18 }}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-3 shrink-0" style={{ color: PURPLE }}>{hasChild ? (isOpen ? '−' : '+') : ''}</span>
            {depth > 0 && <span className="text-[10px] text-gray-400 border border-gray-200 rounded px-1 shrink-0">{label(myDim)}</span>}
            <span className="block truncate" style={{ maxWidth: 190 - depth * 18 }} title={row.name}>{row.name}</span>
          </div>
        </td>
        <td className="px-2.5 py-1.5 text-gray-500 whitespace-nowrap text-[12px]">{row.uomNames ?? ''}</td>
        {COLUMNS.filter((c) => c.num).map((c) => (
          <td key={c.key} className={`text-right px-2.5 py-1.5 tabular-nums whitespace-nowrap ${c.key === 'totalIncTax' ? 'text-gray-800' : 'text-gray-600'}`}>
            {c.fmt(row)}
          </td>
        ))}
      </tr>
      {isOpen && childRows === 'loading' && (
        <tr><td colSpan={COLUMNS.length} className="text-center py-3 text-xs text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
      )}
      {isOpen && childRows === 'error' && (
        <tr><td colSpan={COLUMNS.length} className="text-center py-3 text-xs text-red-500">{isEn ? 'Failed to load' : '加载失败'}</td></tr>
      )}
      {isOpen && Array.isArray(childRows) && childRows.length === 0 && (
        <tr><td colSpan={COLUMNS.length} className="text-center py-3 text-xs text-gray-400">{isEn ? 'No data' : '暂无数据'}</td></tr>
      )}
      {isOpen && Array.isArray(childRows) && sortRows(childRows).map((c) => (
        <TreeRows
          key={c.key}
          sel={sel}
          row={c}
          ancestors={next}
          dim={dim}
          nodes={nodes}
          open={open}
          isEn={isEn}
          label={label}
          sortRows={sortRows}
          onToggle={onToggle}
        />
      ))}
    </Fragment>
  )
}
