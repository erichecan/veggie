import { prisma } from '@/lib/db'
import type { Prisma } from '@/lib/generated/prisma/client'
import type { OdooPricelistItem } from '@/lib/types'

/**
 * 价格表归档的前置检查与「把客户从一张价格表挪走」（20261030）。
 *
 * 之前归档只是把 active 置 false，挂着它的客户原样留着：定价引擎不看 active，
 * 归档的表照样给这些客户算价；客户列表筛选器又只列启用的表，找不出谁还挂着它
 * （客户 77 → M7N3M1test 就是这么来的）。现在约定：**不允许出现「客户挂着已归档
 * 价格表」的状态**——归档前必须先把客户替换成别的表或移除，跟 DELETE 的 409
 * 防孤儿检查是同一个思路。
 *
 * 计价保持现状（客户决定）：引擎仍然不看 active，存量挂着归档表的客户在清理完之前
 * 价格不变，不会今天突然变价。
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface PricelistCustomerUsage {
  customerId: string
  customerNo: number
  name: string
  isActive: boolean
  /** 这张表在该客户价格表链里的位置（1 = 最高优先级） */
  sequence: number
  /** 该客户除这张表外还挂了几张——为 0 时移除后会退回牌价，弹窗里要单独提示 */
  otherPricelistCount: number
}

export interface PricelistUsage {
  customers: PricelistCustomerUsage[]
  /** 公式基于这张表（formulaBase='pricelist'）的其他**启用中**的价格表 */
  referencedBy: { id: string; name: string }[]
}

export async function getPricelistUsage(db: Db, pricelistId: string): Promise<PricelistUsage> {
  const links = await db.customerPricelist.findMany({
    where: { pricelistId },
    select: {
      sequence: true,
      customer: {
        select: {
          id: true, customerNo: true, name: true, isActive: true,
          _count: { select: { pricelists: true } },
        },
      },
    },
  })
  const customers = links
    .map(l => ({
      customerId: l.customer.id,
      customerNo: l.customer.customerNo,
      name: l.customer.name,
      isActive: l.customer.isActive,
      sequence: l.sequence,
      otherPricelistCount: l.customer._count.pricelists - 1,
    }))
    .sort((a, b) => a.customerNo - b.customerNo)

  return { customers, referencedBy: await findReferencingPricelists(db, pricelistId) }
}

/**
 * 嵌套引用：别的启用中价格表的公式规则以这张表为基准。被引用的表归档后引擎照样能算，
 * 但它从此只读、在界面上也不再能被选到，引用方等于挂在一张"看不见"的表上——
 * 所以归档前要求先改掉引用方的规则。已归档的引用方不拦（它本身也不再维护）。
 */
async function findReferencingPricelists(db: Db, pricelistId: string): Promise<{ id: string; name: string }[]> {
  const others = await db.odooPricelist.findMany({
    where: { active: true, id: { not: pricelistId } },
    select: { id: true, name: true, items: true },
  })
  return others
    .filter(pl => ((pl.items as unknown as OdooPricelistItem[]) ?? []).some(
      it => it.computeType === 'formula' && it.formulaBase === 'pricelist' && it.basedOnPricelistId === pricelistId,
    ))
    .map(pl => ({ id: pl.id, name: pl.name }))
}

/** 归档被拦下的原因；都没有返回 null */
export async function archiveBlockReason(db: Db, pricelistId: string): Promise<string | null> {
  const customerCount = await db.customerPricelist.count({ where: { pricelistId } })
  if (customerCount > 0) {
    return `价格表被 ${customerCount} 个客户使用中，不能直接归档。请在价格表页面点「归档」，先把这些客户替换成其他价格表或移除。`
  }
  const refs = await findReferencingPricelists(db, pricelistId)
  if (refs.length > 0) {
    return `价格表被以下价格表的公式引用为基准，不能归档：${refs.map(r => r.name).join('、')}。请先修改这些规则。`
  }
  return null
}

export interface ReassignResult {
  /** 换成了替换表的客户数 */
  replaced: number
  /** 原本就已挂着替换表的客户数（替换表移到旧表的位置，不会重复挂两次） */
  merged: number
  /** 直接移除（没有替换表）的客户数 */
  removed: number
}

/**
 * 把客户从 fromId 挪走：给了 toId 就在原来的优先级位置换成 toId，否则直接移除。
 * customerIds 不传 = 挂着 fromId 的全部客户。
 *
 * 只用 updateMany/deleteMany，跟客户数量无关地固定几条 SQL——Neon 单事务 5s 上限下
 * 几百个客户一次挪完也不会超时。
 */
export async function reassignPricelistCustomers(
  tx: Prisma.TransactionClient,
  fromId: string,
  toId: string | null,
  customerIds?: string[],
): Promise<ReassignResult> {
  const scope: Prisma.CustomerPricelistWhereInput = {
    pricelistId: fromId,
    ...(customerIds ? { customerId: { in: customerIds } } : {}),
  }

  if (!toId) {
    const { count } = await tx.customerPricelist.deleteMany({ where: scope })
    return { replaced: 0, merged: 0, removed: count }
  }

  // (customerId, pricelistId) 有唯一约束：已经挂着替换表的客户，先删掉他原有的那行替换表，
  // 再把旧表那行改成替换表——替换表接管旧表的优先级位置，跟没挂过替换表的客户一个口径
  // （否则 A#1、X#2、B#3 换成 B 后变成 X 优先于 B，原来最优先的定价被悄悄降级）
  const affected = (await tx.customerPricelist.findMany({ where: scope, select: { customerId: true } }))
    .map(l => l.customerId)
  const alreadyHasTarget = affected.length > 0
    ? (await tx.customerPricelist.findMany({
        where: { pricelistId: toId, customerId: { in: affected } },
        select: { customerId: true },
      })).map(l => l.customerId)
    : []

  const merged = alreadyHasTarget.length > 0
    ? (await tx.customerPricelist.deleteMany({ where: { pricelistId: toId, customerId: { in: alreadyHasTarget } } })).count
    : 0
  const { count } = await tx.customerPricelist.updateMany({
    where: scope,
    data: { pricelistId: toId },
  })
  return { replaced: count - merged, merged, removed: 0 }
}

/**
 * 客户保存时新挂上的价格表里有没有已归档的——有就返回它们的名字。
 * 已经挂着的归档表允许原样保留（存量清理期间客户的其他字段照常能改），只拦「新挂上去」。
 */
export async function newlyAttachedArchivedPricelists(
  db: Db,
  nextIds: string[],
  existingIds: string[] = [],
): Promise<string[]> {
  const added = nextIds.filter(pid => !existingIds.includes(pid))
  if (added.length === 0) return []
  const archived = await db.odooPricelist.findMany({
    where: { id: { in: added }, active: false },
    select: { name: true },
  })
  return archived.map(p => p.name)
}
