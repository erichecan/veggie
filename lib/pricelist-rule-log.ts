/**
 * 价格规则改价留痕的落库部分(纯计算在 lib/pricelist-diff.ts)。
 * PUT /api/pricelists/[id]、价格表批量导入、删除商品 三处共用。
 */
import { prisma } from './db'
import { categoryPathMap } from './category-path'
import {
  diffPricelistItems, ruleChangesToLogChanges, ruleLogsByProduct, productRuleLogDetail,
  type RuleChange, type RuleTargetLabeler,
} from './pricelist-diff'

interface LogUser { userId: string; email: string; name: string }

/** 查出变化涉及的商品/分类名，做成 chatter 字段前缀 */
export async function ruleTargetLabeler(changes: RuleChange[]): Promise<RuleTargetLabeler> {
  const productIds = [...new Set(changes.map(c => c.productId).filter((v): v is string => !!v))]
  const needCategories = changes.some(c => c.categoryId)
  const [products, categories] = await Promise.all([
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, productNo: true } }) : [],
    // 分类用完整路径(同名子分类区分得开)，要整棵树才拼得出来；分类表很小
    needCategories ? prisma.productCategory.findMany({ select: { id: true, name: true, parentId: true } }) : [],
  ])
  const productLabel = new Map(products.map(p => [p.id, `${p.name} [#${p.productNo}]`]))
  const categoryLabel = categoryPathMap(categories)
  return (c) => {
    if (c.applyOn === 'product' || c.applyOn === 'variant') return c.productId ? productLabel.get(c.productId) ?? c.productId : 'Product ?'
    if (c.applyOn === 'category') return `Category ${c.categoryId ? categoryLabel.get(c.categoryId) ?? c.categoryId : '?'}`
    return 'All Products'
  }
}

/** 价格表 chatter 用的 changes(没有规则变化时返回空对象) */
export async function pricelistRuleLogChanges(changes: RuleChange[]): Promise<Record<string, { before: unknown; after: unknown }>> {
  if (changes.length === 0) return {}
  return ruleChangesToLogChanges(changes, await ruleTargetLabeler(changes))
}

/**
 * 给每个受影响的商品写一条 resource='pricelist-rule'、resourceId=商品 id 的日志，
 * 商品页「价格表」区块按商品 id 查改价历史。永不抛错(同 writeLog)。
 */
export async function writeProductRuleLogs(user: LogUser, pricelistName: string, changes: RuleChange[], via?: string): Promise<void> {
  const logs = ruleLogsByProduct(changes, pricelistName)
  if (logs.length === 0) return
  try {
    await prisma.actionLog.createMany({
      data: logs.map(l => ({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'UPDATE' as const,
        resource: 'pricelist-rule',
        resourceId: l.productId,
        detail: productRuleLogDetail(pricelistName, l.kinds, via),
        changes: l.changes as object,
      })),
    })
  } catch (e) {
    console.error('[writeProductRuleLogs]', e)
  }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * 删除商品时，把各价格表里锁定这个商品的规则(applyOn=product/variant)一并去掉 —— 20261008。
 * 以前商品删了规则还留着，详情页显示成「-」，只能靠 20261008000002 那种迁移事后清理。
 * 在调用方的事务里执行，和删商品同进同退；返回每个被改动的价格表及删掉的规则，供写日志。
 */
export async function removeProductRulesInTx(tx: Tx, productId: string): Promise<Array<{ id: string; name: string; changes: RuleChange[] }>> {
  const pricelists = await tx.odooPricelist.findMany({ select: { id: true, name: true, items: true } })
  const touched: Array<{ id: string; name: string; changes: RuleChange[] }> = []
  for (const pl of pricelists) {
    const items = Array.isArray(pl.items) ? (pl.items as unknown as Array<Record<string, unknown>>) : []
    const kept = items.filter(it => {
      if (!it || typeof it !== 'object') return true
      if (it.applyOn === 'variant') return (it.productVariantId || it.productTemplateId) !== productId
      if (it.applyOn === 'product') return (it.productTemplateId || it.productVariantId) !== productId
      return true
    })
    if (kept.length === items.length) continue
    await tx.odooPricelist.update({ where: { id: pl.id }, data: { items: kept as unknown as object[] } })
    touched.push({ id: pl.id, name: pl.name, changes: diffPricelistItems(items, kept) })
  }
  return touched
}
