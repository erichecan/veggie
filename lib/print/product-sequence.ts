/**
 * 按 productId 批量取商品 sequence，供各打印模板排序用（见 lib/print/line-sort.ts）。
 *
 * 商品列表页显示与编辑、客户调打印顺序改的都是 Product.sequence
 * （ProductTemplate 已并入 Product，见 docs/20260825-producttemplate-merge-tasks.md）。
 *
 * 一次查询拿完，不要在渲染循环里逐行查 —— 一张单几十行，逐行查就是几十次往返。
 */
import { prisma } from '@/lib/db'

export async function fetchProductSequences(
  productIds: readonly (string | null | undefined)[],
): Promise<Map<string, number | null>> {
  const ids = [...new Set(productIds.filter((id): id is string => !!id))]
  if (ids.length === 0) return new Map()

  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, sequence: true },
  })

  // 查不到的（商品被删/脏 productId）不放进 map，取值时得到 undefined → 按"没有 sequence"处理
  return new Map(rows.map(r => [r.id, r.sequence ?? null]))
}

/** 把 sequence 附到行上，供 sortLinesBySequence 使用 */
export function attachProductSequence<T extends { productId?: string | null }>(
  lines: readonly T[],
  seqMap: Map<string, number | null>,
): Array<T & { productSequence: number | null }> {
  return lines.map(l => ({
    ...l,
    productSequence: l.productId ? (seqMap.get(l.productId) ?? null) : null,
  }))
}

/**
 * 一步到位：查 sequence 并附到行上。打印路由里就一行调用，
 * 少一次「查了但忘了附」或「附了但忘了查」的机会。
 */
export async function withProductSequence<T extends { productId?: string | null }>(
  lines: readonly T[],
): Promise<Array<T & { productSequence: number | null }>> {
  const seqMap = await fetchProductSequences(lines.map(l => l.productId))
  return attachProductSequence(lines, seqMap)
}
