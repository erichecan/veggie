import { prisma } from '@/lib/db'

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '')
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [s]
  const grams: string[] = []
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2))
  return grams
}

/** Dice 系数：子串包含关系视为强信号(0.9)，否则按 bigram 重叠度算 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.9

  const bigramsA = bigrams(na)
  const bigramsB = bigrams(nb)
  const used = new Array(bigramsB.length).fill(false)
  let matches = 0
  for (const g of bigramsA) {
    const idx = bigramsB.findIndex((x, i) => x === g && !used[i])
    if (idx !== -1) { matches++; used[idx] = true }
  }
  return (2 * matches) / (bigramsA.length + bigramsB.length)
}

export const SIMILARITY_THRESHOLD = 0.5

export interface SimilarProductCandidate {
  id: string
  name: string
  internalRef: string | null
  score: number
}

/** 商品量级约 1718 条，全表内存模糊匹配即可，不需要 trigram 索引 */
export async function findSimilarProducts(name: string, excludeId?: string): Promise<SimilarProductCandidate[]> {
  const query = name.trim()
  if (query.length < 2) return []

  const candidates = await prisma.productTemplate.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, internalRef: true },
  })

  return candidates
    .map(c => ({ id: c.id, name: c.name, internalRef: c.internalRef, score: nameSimilarity(query, c.name) }))
    .filter(c => c.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}
