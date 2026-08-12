/**
 * 销售矩阵：商品 × 日期（按日） / 商品 × 星期（按周）
 * ============================================================================
 * 台账 D9：「按日、按周维度看每天销售情况、库存情况、商品数量，给采购提供感性判断依据」。
 *
 * 采购要的不是一个总数，而是**一行一个商品、一列一天**的那张表：
 * 周一到周日每天走多少、手上还有多少、按现在的节奏还能撑几天。
 * 所以矩阵除了各列销量，还带 **当前库存** 与 **可承诺量 ATP = 库存 − 区间已订**
 * （与「按商品」查看方式的 ATP 同一个式子，不另起一套）。
 *
 * 纯函数、不查库：屏幕表格与 CSV 导出共用同一份结果，
 * 「导出的和屏幕上看到的不一样」这种事从结构上就不可能发生。
 */

export type MatrixGranularity = 'day' | 'week'

/** 与 SalesStats 的 ReportLine 结构对齐（只取矩阵需要的字段） */
export interface MatrixSourceLine {
  /** YYYY-MM-DD（配送日） */
  date: string
  productId: string
  productName: string
  uomName: string
  qty: number
  amount: number
  /** 该商品当前库存（每行都带同一个值，按商品归并时取其一） */
  qtyOnHand: number
  /** 商品目录顺序号，供「按目录排序」用 */
  sequence: number
}

export interface MatrixColumn {
  /** 按日 = YYYY-MM-DD；按周 = 0..6（周一起） */
  key: string
  /** 表头文字：按日 = MM-DD，按周 = 周一…周日 */
  label: string
}

export interface MatrixRow {
  productId: string
  productName: string
  uomName: string
  sequence: number
  /** 与 columns 同序的数量 */
  qty: number[]
  /** 与 columns 同序的金额（税前） */
  amount: number[]
  totalQty: number
  totalAmount: number
  qtyOnHand: number
  /** 可承诺量 = 当前库存 − 本区间已订量 */
  atp: number
}

export interface SalesMatrix {
  granularity: MatrixGranularity
  columns: MatrixColumn[]
  rows: MatrixRow[]
  grand: { qty: number[]; amount: number[]; totalQty: number; totalAmount: number }
}

/**
 * 周一=0 … 周日=6。
 * ⛔ 与 SalesStats 的星期筛选、打印模板 day-wise-report-template 的 dayOfWeek() 必须同一套编号，
 * 否则「筛周三」筛出来的和「周三列」对不上。用 UTC 中午取星期，避开时区把日期推到隔壁。
 */
export function weekdayIndex(dateStr: string): number {
  return (new Date(`${dateStr}T12:00:00Z`).getUTCDay() + 6) % 7
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 汇总成矩阵。
 *
 * ⚠️ 按 **productId** 归并，不是按商品名 —— 原「商品×星期汇总」按名字归并，
 * 同名不同规格的商品会被并成一行（A1 走查记过这个坑），而库存与 ATP 是按
 * 商品 id 的，并行之后那两列就没法解释。合计不受影响，只是行拆得更细。
 * 没有 productId 的历史行回退到用名字当键，不至于整批丢掉。
 */
export function buildSalesMatrix(
  lines: readonly MatrixSourceLine[],
  granularity: MatrixGranularity,
  weekdayLabels: readonly string[],
): SalesMatrix {
  const columns: MatrixColumn[] = granularity === 'week'
    ? weekdayLabels.map((label, i) => ({ key: String(i), label }))
    : [...new Set(lines.map(l => l.date))].sort().map(d => ({ key: d, label: d.slice(5) }))

  const colIndex = new Map(columns.map((c, i) => [c.key, i]))
  const rowMap = new Map<string, MatrixRow>()

  for (const l of lines) {
    const key = l.productId || l.productName
    let row = rowMap.get(key)
    if (!row) {
      row = {
        productId: l.productId,
        productName: l.productName,
        uomName: l.uomName,
        sequence: l.sequence,
        qty: new Array(columns.length).fill(0),
        amount: new Array(columns.length).fill(0),
        totalQty: 0,
        totalAmount: 0,
        qtyOnHand: l.qtyOnHand,
        atp: 0,
      }
      rowMap.set(key, row)
    }
    const ci = colIndex.get(granularity === 'week' ? String(weekdayIndex(l.date)) : l.date)
    if (ci === undefined) continue
    row.qty[ci] += l.qty
    row.amount[ci] += l.amount
    row.totalQty += l.qty
    row.totalAmount += l.amount
  }

  const rows = [...rowMap.values()]
  for (const r of rows) {
    r.qty = r.qty.map(round2)
    r.amount = r.amount.map(round2)
    r.totalQty = round2(r.totalQty)
    r.totalAmount = round2(r.totalAmount)
    r.atp = round2(r.qtyOnHand - r.totalQty)
  }

  const grand = {
    qty: columns.map((_, i) => round2(rows.reduce((s, r) => s + r.qty[i], 0))),
    amount: columns.map((_, i) => round2(rows.reduce((s, r) => s + r.amount[i], 0))),
    totalQty: round2(rows.reduce((s, r) => s + r.totalQty, 0)),
    totalAmount: round2(rows.reduce((s, r) => s + r.totalAmount, 0)),
  }

  return { granularity, columns, rows, grand }
}

export interface MatrixCsvLabels {
  product: string
  uom: string
  total: string
  amount: string
  onHand: string
  atp: string
  grand: string
}

/**
 * 矩阵 → CSV 的表头与数据行（真正落盘交给 lib/csv-export.downloadCsv，
 * 转义与 BOM 都在那边，本函数不碰格式）。
 * 合计行放在最后一行，Excel 里排序时它会被带走 —— 采购普遍会排序，
 * 所以合计同时也在表头下方标了列名，不依赖行位置。
 */
export function matrixToCsvRows(
  matrix: SalesMatrix,
  labels: MatrixCsvLabels,
): { headers: string[]; rows: (string | number)[][] } {
  const headers = [
    labels.product,
    labels.uom,
    ...matrix.columns.map(c => c.label),
    labels.total,
    labels.amount,
    labels.onHand,
    labels.atp,
  ]
  const rows: (string | number)[][] = matrix.rows.map(r => [
    r.productName,
    r.uomName,
    ...r.qty,
    r.totalQty,
    r.totalAmount,
    r.qtyOnHand,
    r.atp,
  ])
  rows.push([
    labels.grand,
    '',
    ...matrix.grand.qty,
    matrix.grand.totalQty,
    matrix.grand.totalAmount,
    '',
    '',
  ])
  return { headers, rows }
}
