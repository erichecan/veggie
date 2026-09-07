/**
 * 按 (productId, uomId) 批量取该可售单位的装货顺序（ProductSaleUom.sequence），
 * 供打印/拣货单排序用（见 lib/print/line-sort.ts 的 sortLinesByUomSequence）。
 *
 * 挂在 ProductSaleUom 上，是"单位"的属性不是"商品"的属性——同一商品箱装和散装
 * 可能一个耐压一个怕压，跟 fetchProductSequences（商品级，单据里排第几行）不是一回事。
 * 语义照抄 Product.sequence：数字越小越先装/放最下，越大越后装/放最上，没有值排最后。
 *
 * 一次查询拿完，不要在渲染循环里逐行查。
 */
import { prisma } from '@/lib/db'

function key(productId: string, uomId: string | null | undefined): string {
  return `${productId}::${uomId ?? ''}`
}

export async function fetchUomSequences(
  lines: readonly { productId?: string | null; uomId?: string | null }[],
): Promise<Map<string, number | null>> {
  const productIds = [...new Set(lines.map(l => l.productId).filter((id): id is string => !!id))]
  if (productIds.length === 0) return new Map()

  const rows = await prisma.productSaleUom.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, uomId: true, isDefault: true, sequence: true },
  })

  const map = new Map<string, number | null>()
  // 基础单位（isDefault）先写一遍，用商品 id 本身当 key 兜底——行上 uomId 缺失/匹配不到
  // 具体单位时（历史脏数据、旧版没存 uomId 的行）落到这个值，而不是一律当"没有"。
  for (const r of rows) {
    if (r.isDefault) map.set(r.productId, r.sequence)
  }
  for (const r of rows) {
    map.set(key(r.productId, r.uomId), r.sequence)
  }
  return map
}

/** 查具体一行的装货顺序：优先按 productId+uomId 精确匹配，查不到落回该商品基础单位的值，再没有就 null（排序时按"没有"处理，排最后） */
export function resolveUomSequence(
  map: Map<string, number | null>,
  productId: string | null | undefined,
  uomId: string | null | undefined,
): number | null {
  if (!productId) return null
  const exact = map.get(key(productId, uomId))
  if (exact !== undefined) return exact
  return map.get(productId) ?? null
}

interface UomSequenceByNameRow {
  productId: string
  uomId: string
  uomName: string
  uomNameZh: string | null
  isDefault: boolean
  sequence: number | null
}

/**
 * 供 Pallet.items / 待分盘池这类只存 productId+uomName（字符串，没有 uomId）的快照用——
 * 一次查出候选行，调用方按 productId+uomName 反查。跟 fetchUomSequences（按 uomId 精确
 * 匹配）是两个入口，因为两处数据形状不一样。
 */
export async function fetchUomSequenceRows(
  productIds: readonly string[],
): Promise<UomSequenceByNameRow[]> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return []
  const rows = await prisma.productSaleUom.findMany({
    where: { productId: { in: ids } },
    select: { productId: true, uomId: true, isDefault: true, sequence: true, uom: { select: { name: true, nameZh: true } } },
  })
  return rows.map(r => ({
    productId: r.productId,
    uomId: r.uomId,
    uomName: r.uom.name,
    uomNameZh: r.uom.nameZh ?? null,
    isDefault: r.isDefault,
    sequence: r.sequence,
  }))
}

/**
 * 按 productId + uomName(字符串) 反查装货顺序：中英文单位名都试，都对不上就退回该商品
 * 基础单位，再没有就 null。理论上存在同商品下单位重名的碰撞风险，业务上不会出现，可接受。
 */
export function resolveUomSequenceByName(
  rows: readonly UomSequenceByNameRow[],
  productId: string,
  uomName: string | null | undefined,
): number | null {
  const forProduct = rows.filter(r => r.productId === productId)
  if (uomName) {
    const hit = forProduct.find(r => r.uomName === uomName || r.uomNameZh === uomName)
    if (hit) return hit.sequence
  }
  return forProduct.find(r => r.isDefault)?.sequence ?? null
}

/** 排序键：没有值排最后，跟 lib/print/line-sort.ts 的商品 sequence 同一套规则 */
export function uomSequenceKey(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
}
