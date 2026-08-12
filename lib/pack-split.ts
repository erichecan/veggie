/**
 * 整箱 / 零散拆分
 * ============================================================================
 * 台账 D4。需求：拣货单上的数量要拆成「N 箱 + M 散」，仓库照着拣不用心算。
 *
 * 为什么要拆：拣货单聚合后是「这趟车这个商品一共 35 包」。仓库看到 35 要自己
 * 除以箱规，容易错；直接印「2 箱 + 11 包」他搬 2 箱再数 11 个就行。
 *
 * ⚠️ 与已有的 `PickingVariant`（'storable' / 'consumable'，纸面标题写作
 * 「整箱整袋 STOCKABLE」「零散货 CONSUMABLE」）**不是一回事**。那个按商品
 * `ProductTemplate.type` 分成两张表，是「哪类货」；本文件按数量拆，是「这个数
 * 怎么拿」。两者措辞撞车但含义无关，改动时别混。
 *
 * 口径与 `lib/inventory.ts: toStockQty` 一致：`Uom.factor` 表示「1 个本单位 =
 * factor 个参考单位」，所以箱规 = 大单位 factor / 基准单位 factor。
 */

export interface PackSpec {
  /** 1 个大单位 = 多少个基准单位（如 1 箱 = 12 包 → 12） */
  factor: number
  /** 大单位显示名，如 CASE / 箱 */
  caseUomName: string
  /** 基准单位显示名，如 PCS / 包 */
  baseUomName: string
}

export interface PackSplit {
  /** 整箱数 */
  cases: number
  /** 拆开后剩下的零散数（以基准单位计） */
  loose: number
  /** 既有整箱又有零散——纸面要同时印两段 */
  mixed: boolean
  /** 给拣货单直接用的一行字，如「2 箱 + 6 包」 */
  text: string
}

/** 数量取到 3 位小数，消掉 0.1+0.2 这类浮点尾巴 */
const r3 = (n: number) => Math.round(n * 1000) / 1000

/** 去掉无意义的小数尾零：12.0 → 12，2.50 → 2.5 */
function fmt(n: number): string {
  const v = r3(n)
  return Number.isInteger(v) ? String(v) : String(v)
}

/**
 * 把基准单位下的数量拆成整箱 + 零散。
 *
 * 返回 `null` 表示**不该拆**（而不是「拆不出来」）——调用方照原样印数量即可：
 *   - 没有箱规（商品没配大单位）
 *   - 箱规 ≤ 1（等于没箱规，硬拆只会把「5 包」印成「5 箱 + 0 包」）
 *   - 数量为负或非有限数（退货冲减等场景，拆箱没有意义）
 */
export function splitIntoPacks(qtyInBase: number, spec: PackSpec | null | undefined): PackSplit | null {
  if (!spec) return null
  const factor = Number(spec.factor)
  if (!Number.isFinite(factor) || factor <= 1) return null
  if (!Number.isFinite(qtyInBase) || qtyInBase < 0) return null

  const qty = r3(qtyInBase)
  const cases = Math.floor(r3(qty / factor))
  const loose = r3(qty - cases * factor)

  const parts: string[] = []
  if (cases > 0) parts.push(`${fmt(cases)} ${spec.caseUomName}`)
  if (loose > 0) parts.push(`${fmt(loose)} ${spec.baseUomName}`)
  // 数量为 0 时两段都空，仍要印出一个「0 基准单位」而不是空白格
  if (parts.length === 0) parts.push(`0 ${spec.baseUomName}`)

  return { cases, loose, mixed: cases > 0 && loose > 0, text: parts.join(' + ') }
}

/**
 * 从商品的可售单位里挑箱规：取 factor 最大的那个大单位。
 *
 * 一个商品可能挂多个大单位（箱、托盘），拣货按**最大**的拆最省事——
 * 能整托盘搬就不该拆成箱。
 */
export function pickLargestPack(
  saleUoms: Array<{ name: string; factor: number; type: string }>,
  baseUomName: string,
): PackSpec | null {
  const biggest = saleUoms
    .filter((u) => Number(u.factor) > 1)
    .sort((a, b) => Number(b.factor) - Number(a.factor))[0]
  if (!biggest) return null
  return { factor: Number(biggest.factor), caseUomName: biggest.name, baseUomName }
}
