/**
 * 供应商账单三单核销（PO 下单量 / GoodsReceipt 收货量 / VendorBill 账单量）
 * ================================================================================
 * 现算现得，不落地存储字段——本项目已经因为"派生状态存字段、和源头数据脱节"吃过
 * 多次亏（docs/20260624-data-ownership-audit.md）。核对成本很低：一次详情页请求内
 * 按 productId 把账单行和 PO 行配对比较即可。
 *
 * 判定基准是"收货量 vs 账单量"（而不是"收货量 vs 下单量"）——3-way match 的核心
 * 目的是防止"为没收到的货付款"，所以状态命名以收货量为参照物：
 *   - MATCHED：账单量 == 收货量（在误差范围内），该给多少钱、给的就是多少钱
 *   - OVER_RECEIVED：收货量 > 账单量，收到的货比账单上多——供应商可能少开了账单，
 *     或者这批货还有后续账单在路上
 *   - UNDER_RECEIVED：收货量 < 账单量，账单在为还没收到的货收钱——这是财务最需要
 *     拦下来的一种，付款前必须核实
 * orderedQty（PO 下单量）只作为参考信息展示，不参与状态判定。
 *
 * 账单行按 productId 在 PO 行里查不到匹配项时（比如账单加了 PO 之外的临时商品，
 * 或账单没有关联任何 PO），视为收货量 0——账单在为"PO 上完全没有的东西"收钱，
 * 同样应该落在 UNDER_RECEIVED，提醒人工核实，而不是静默跳过。
 */

/** 数量比较容差：schema 里数量字段是 Decimal(14,3)，取比最小精度更松一档 */
const QTY_EPSILON = 0.001

export type ReconciliationStatus = 'MATCHED' | 'OVER_RECEIVED' | 'UNDER_RECEIVED'

export interface ReconciliationPoLine {
  productId: string
  orderedQty: number
  receivedQty: number
}

export interface ReconciliationBillLine {
  productId: string
  productName: string
  billedQty: number
}

export interface ReconciliationLineResult {
  productId: string
  productName: string
  orderedQty: number
  receivedQty: number
  billedQty: number
  diff: number
  status: ReconciliationStatus
}

export interface VendorBillReconciliation {
  /** 整单状态：任意一行不是 MATCHED，整单跟着最严重的那一种（UNDER_RECEIVED 优先于 OVER_RECEIVED） */
  status: ReconciliationStatus
  lines: ReconciliationLineResult[]
}

function statusOf(receivedQty: number, billedQty: number): ReconciliationStatus {
  const diff = receivedQty - billedQty
  if (Math.abs(diff) < QTY_EPSILON) return 'MATCHED'
  return diff > 0 ? 'OVER_RECEIVED' : 'UNDER_RECEIVED'
}

/**
 * @param poLines 该账单关联采购单的全部行（账单未关联 PO 时传空数组，此时所有账单
 *   行的 receivedQty 都按 0 处理）
 * @param billLines 该账单自己的行（VendorBill.lines JSON）
 */
export function reconcileVendorBill(
  poLines: ReconciliationPoLine[],
  billLines: ReconciliationBillLine[],
): VendorBillReconciliation {
  // 同一 productId 在账单里可能重复出现（理论上不该，但不假设输入干净），先合并
  const billedByProduct = new Map<string, { productName: string; billedQty: number }>()
  for (const line of billLines) {
    const prev = billedByProduct.get(line.productId)
    billedByProduct.set(line.productId, {
      productName: prev?.productName ?? line.productName,
      billedQty: (prev?.billedQty ?? 0) + line.billedQty,
    })
  }

  const poByProduct = new Map<string, { orderedQty: number; receivedQty: number }>()
  for (const line of poLines) {
    const prev = poByProduct.get(line.productId)
    poByProduct.set(line.productId, {
      orderedQty: (prev?.orderedQty ?? 0) + line.orderedQty,
      receivedQty: (prev?.receivedQty ?? 0) + line.receivedQty,
    })
  }

  const lines: ReconciliationLineResult[] = []
  for (const [productId, billed] of billedByProduct) {
    const po = poByProduct.get(productId)
    const orderedQty = po?.orderedQty ?? 0
    const receivedQty = po?.receivedQty ?? 0
    const diff = round3(receivedQty - billed.billedQty)
    lines.push({
      productId,
      productName: billed.productName,
      orderedQty: round3(orderedQty),
      receivedQty: round3(receivedQty),
      billedQty: round3(billed.billedQty),
      diff,
      status: statusOf(receivedQty, billed.billedQty),
    })
  }

  // 整单状态：UNDER_RECEIVED（该拦的钱）优先于 OVER_RECEIVED，两者都没有才是 MATCHED
  let overall: ReconciliationStatus = 'MATCHED'
  for (const line of lines) {
    if (line.status === 'UNDER_RECEIVED') { overall = 'UNDER_RECEIVED'; break }
    if (line.status === 'OVER_RECEIVED') overall = 'OVER_RECEIVED'
  }

  return { status: overall, lines }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
