/**
 * 打印单据「可售单位换算说明」的纯格式化部分（同构，无 Prisma 依赖）
 * ============================================================================
 * DEV-PLAN 20260823 模块 B。查询部分(Prisma)拆到 `uom-conversion-loader.ts`
 * (server-only)——这个文件被 trip-delivery-template.ts 等模板文件 import，
 * 那些模板同时也在客户端渲染用(见 trip-common.ts 顶部同样的约束)，这里混进
 * Prisma 会把 `pg`/`@prisma/adapter-pg` 拖进浏览器 bundle 导致打包失败
 * (20260823 build 实测踩过一次)。
 */

export interface UomConversionInfo {
  /** 1 个此单位 = 多少个基准单位 */
  factor: number
  /** 这一行单位的显示名 */
  thisUomName: string
  /** 基准单位的显示名 */
  baseUomName: string
  /** 基准单位的净重（kg），没配则为 null —— 用于换算出实物重量作为第二行小字辅助 */
  netWeight: number | null
  /** 这一行选的可售单位自己的毛重（kg，ProductSaleUom.grossWeight，20260911）；
   * 跟上面 netWeight 不是一回事——netWeight 挂在基准单位上、按 factor 折算出估算重量，
   * 这个是这个具体可售单位自己配的毛重，不需要 factor 折算，没配则为 null */
  grossWeight: number | null
}

/** `${productId}::${uomId}` 的 key */
export function uomConversionKey(productId: string, uomId: string | null | undefined): string {
  return `${productId}::${uomId ?? ''}`
}

/** 四舍五入到合理精度，去掉浮点尾巴 */
function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * 把换算信息 + 这一行的数量，格式化成两行说明文字（DEV-PLAN 决策#2）：
 * - factor < 1（这单位比基准小）：倒数换算，如「1 CASE = 40 × PKT」
 * - factor ≥ 1（这单位比基准大）：直接顺述，如「1 CASE = 6 × PKT」；factor = 1（就是
 *   基准单位本身）不显示换算，没有信息量
 * - 配了 netWeight 时，第二行给出这一行数量对应的实物重量估算，如「≈ 1.5kg」
 * - 配了 grossWeight 时，额外给一行这一行数量对应的毛重，带「毛重」标题，如「毛重 ≈ 3.4kg」——
 *   跟上面 weightLine 分开显示，因为口径不同（一个是净重折算估算，一个是配置的实际毛重），
 *   且不受 factor=1 限制——基准单位自己也能配毛重
 *
 * 返回 null 表示三行都不该显示（没有换算信息，或数量非正数）。
 */
export function formatUomConversionHint(
  info: UomConversionInfo | undefined,
  qty: number,
): { conversionLine: string | null; weightLine: string | null; grossWeightLine: string | null } | null {
  if (!info || !Number.isFinite(qty) || qty <= 0) return null
  const { factor, thisUomName, baseUomName, netWeight, grossWeight } = info

  const conversionLine = factor === 1 ? null : factor < 1
    ? `1 ${baseUomName} = ${round(1 / factor, 2)} × ${thisUomName}`
    : `1 ${thisUomName} = ${round(factor, 2)} × ${baseUomName}`

  let weightLine: string | null = null
  if (netWeight != null && netWeight > 0) {
    const totalKg = qty * factor * netWeight
    weightLine = `≈ ${round(totalKg, 2)}kg`
  }

  // grossWeight 是这个可售单位自己的毛重（如"1箱=3.2kg"），不需要再乘 factor——
  // qty 本来就是按这个单位下的单，直接乘就是这一行的总毛重
  let grossWeightLine: string | null = null
  if (grossWeight != null && grossWeight > 0) {
    const totalGrossKg = qty * grossWeight
    grossWeightLine = `毛重 ≈ ${round(totalGrossKg, 2)}kg`
  }

  return { conversionLine, weightLine, grossWeightLine }
}
