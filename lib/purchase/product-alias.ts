/**
 * 采购单据「原文 → 商品」记忆表的读写（20260824 新增）
 * ============================================================================
 * 解决供应商单据用系统匹配不上的写法（含西班牙语等外语）反复出现的问题：
 * 操作员在核对界面选一次商品，这里就把原文记住；下次同样的写法直接精确命中，
 * 免去每次都要人工挑一遍，参见 lib/purchase/product-match.ts 顶部注释里
 * 「不做 AI 兜底」的理由 —— 这张表就是那个理由成立后留下的替代方案。
 */
import { prisma } from '@/lib/db'
import { normalizeName } from './product-match'

export interface AliasHit {
  productId: string
  productName: string
}

/**
 * 批量查原文对照。只认还能被采购的商品 —— 商品转成不可采购之后，
 * 旧的别名不该继续把人导向一个选不了的商品，那种情况退回正常匹配流程。
 * 归档（status）不算在内：归档只挡销售端选品，采购端认 canBePurchased。
 */
export async function findAliasMatches(rawNames: string[]): Promise<Map<string, AliasHit>> {
  const normalizedNames = [...new Set(rawNames.map(normalizeName).filter(Boolean))]
  if (normalizedNames.length === 0) return new Map()

  const rows = await prisma.productAlias.findMany({
    where: { normalizedName: { in: normalizedNames } },
    select: {
      normalizedName: true,
      product: {
        select: { id: true, name: true, canBePurchased: true },
      },
    },
  })

  const map = new Map<string, AliasHit>()
  for (const row of rows) {
    if (!row.product.canBePurchased) continue
    map.set(row.normalizedName, { productId: row.product.id, productName: row.product.name })
  }
  return map
}

/** 记住一条「原文 → 商品」映射：操作员选中即存，同一原文再选会覆盖旧的 */
export async function saveAlias(rawName: string, productId: string): Promise<void> {
  const normalizedName = normalizeName(rawName)
  if (!normalizedName) return
  await prisma.productAlias.upsert({
    where: { normalizedName },
    update: { productId, rawName },
    create: { normalizedName, rawName, productId },
  })
}
