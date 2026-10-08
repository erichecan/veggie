/**
 * 操作记录里的「引用字段」显示成名字 —— 20261008
 * ============================================================================
 * 客户反馈：客户删掉一个价格表，操作记录显示 `pricelistIds：["pl_51","pl_58"] → ["pl_51"]`，
 * 用户看不懂。ActionLog.changes 存的是写库时的原值(id)，历史数据也都是 id，所以在
 * **读日志时**(GET /api/action-logs)把已知的引用字段换成名字，老记录一并变好看。
 *
 * ⛔ 新增 diffChanges 跟踪的字段如果是 xxxId / xxxIds，要在 REF_FIELDS 里登记它指向哪张表；
 * tests/action-log-refs.test.ts 会扫描各 TRACKED_FIELDS，漏登记会直接测试失败。
 */
import { prisma } from './db'
import { categoryPathMap } from './category-path'
import { ruleSummary } from './pricelist-diff'
import type { PricelistItemInput } from './pricelist-item'

import { REF_FIELDS, type RefKind } from './action-log-ref-fields'

export { REF_FIELDS }

type Change = { before: unknown; after: unknown }

/** 「对象 · 字段」(价格规则改价留痕的 key)取字段部分 */
function refKindOf(key: string): RefKind | undefined {
  const sep = key.lastIndexOf(' · ')
  return REF_FIELDS[sep >= 0 ? key.slice(sep + 3) : key]
}
type LogLike = { changes?: unknown }

function idsOf(v: unknown): string[] {
  if (typeof v === 'string' && v) return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x)
  return []
}

function isRuleArray(v: unknown): v is PricelistItemInput[] {
  return Array.isArray(v) && v.every(x => x && typeof x === 'object' && 'applyOn' in (x as object))
}

/**
 * 原地把 logs[].changes 里的引用 id 换成名字；查不到的(已删除)保留 id 并标注。
 * 价格规则数组(迁移清理时写的 removedItems)换成「Apple [#1]: Fixed 9; …」。
 */
export async function humanizeLogRefs<T extends LogLike>(logs: T[]): Promise<T[]> {
  const want: Record<RefKind, Set<string>> = {
    pricelist: new Set(), user: new Set(), category: new Set(), partner: new Set(),
    uom: new Set(), driverSlot: new Set(), zone: new Set(), order: new Set(), wave: new Set(),
  }
  const productIds = new Set<string>()
  let hasRules = false
  for (const log of logs) {
    const changes = log.changes as Record<string, Change> | null | undefined
    if (!changes || typeof changes !== 'object') continue
    for (const [key, c] of Object.entries(changes)) {
      if (!c || typeof c !== 'object') continue
      const kind = refKindOf(key)
      if (kind) for (const v of [c.before, c.after]) idsOf(v).forEach(id => want[kind].add(id))
      for (const v of [c.before, c.after]) {
        if (!isRuleArray(v)) continue
        hasRules = true
        for (const it of v) {
          const pid = it.productVariantId || it.productTemplateId
          if (pid) productIds.add(pid)
          if (it.categoryId) want.category.add(it.categoryId)
        }
      }
    }
  }
  const total = Object.values(want).reduce((n, s) => n + s.size, 0) + productIds.size
  if (total === 0 && !hasRules) return logs

  const list = (s: Set<string>) => [...s]
  const [pricelists, users, categories, partners, uoms, slots, zones, orders, waves, products] = await Promise.all([
    want.pricelist.size ? prisma.odooPricelist.findMany({ where: { id: { in: list(want.pricelist) } }, select: { id: true, name: true } }) : [],
    want.user.size ? prisma.user.findMany({ where: { id: { in: list(want.user) } }, select: { id: true, name: true } }) : [],
    want.category.size ? prisma.productCategory.findMany({ select: { id: true, name: true, parentId: true } }) : [],
    want.partner.size ? prisma.customer.findMany({ where: { id: { in: list(want.partner) } }, select: { id: true, name: true } }) : [],
    want.uom.size ? prisma.uom.findMany({ where: { id: { in: list(want.uom) } }, select: { id: true, name: true } }) : [],
    want.driverSlot.size ? prisma.driverSlot.findMany({ where: { id: { in: list(want.driverSlot) } }, select: { id: true, driverName: true, timeOfDay: true, batchNum: true } }) : [],
    want.zone.size ? prisma.zone.findMany({ where: { id: { in: list(want.zone) } }, select: { id: true, name: true } }) : [],
    want.order.size ? prisma.order.findMany({ where: { id: { in: list(want.order) } }, select: { id: true, code: true, restaurantName: true } }) : [],
    want.wave.size ? prisma.pickingWave.findMany({ where: { id: { in: list(want.wave) } }, select: { id: true, name: true, waveNumber: true } }) : [],
    productIds.size ? prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, name: true, productNo: true } }) : [],
  ])
  const names: Record<RefKind, Map<string, string>> = {
    pricelist: new Map(pricelists.map(p => [p.id, p.name])),
    user: new Map(users.map(u => [u.id, u.name])),
    category: categoryPathMap(categories),
    partner: new Map(partners.map(p => [p.id, p.name])),
    uom: new Map(uoms.map(u => [u.id, u.name])),
    driverSlot: new Map(slots.map(s => [s.id, `${s.driverName} (${s.timeOfDay.toUpperCase()} ${s.batchNum})`])),
    zone: new Map(zones.map(z => [z.id, z.name])),
    order: new Map(orders.map(o => [o.id, o.code ? `${o.code} (${o.restaurantName})` : o.restaurantName])),
    wave: new Map(waves.map(w => [w.id, w.name || (w.waveNumber != null ? `#${w.waveNumber}` : w.id)])),
  }
  const productName = new Map(products.map(p => [p.id, `${p.name} [#${p.productNo}]`]))

  const nameOf = (kind: RefKind, id: string) => names[kind].get(id) ?? `${id} (deleted)`
  const convert = (kind: RefKind, v: unknown): unknown => {
    if (typeof v === 'string' && v) return nameOf(kind, v)
    if (Array.isArray(v)) {
      const ids = idsOf(v)
      return ids.length ? ids.map(id => nameOf(kind, id)).join(', ') : null
    }
    return v
  }
  const ruleText = (items: PricelistItemInput[]) => items.map(it => {
    const pid = it.productVariantId || it.productTemplateId
    const target = it.applyOn === 'category'
      ? `Category ${it.categoryId ? names.category.get(it.categoryId) ?? '?' : '?'}`
      : it.applyOn === 'global' ? 'All Products'
        : pid ? productName.get(pid) ?? `${pid} (deleted)` : 'Product ?'
    return `${target}: ${ruleSummary(it)}`
  }).join('; ')

  for (const log of logs) {
    const changes = log.changes as Record<string, Change> | null | undefined
    if (!changes || typeof changes !== 'object') continue
    for (const [key, c] of Object.entries(changes)) {
      if (!c || typeof c !== 'object') continue
      const kind = refKindOf(key)
      changes[key] = {
        before: kind ? convert(kind, c.before) : isRuleArray(c.before) ? ruleText(c.before) : c.before,
        after: kind ? convert(kind, c.after) : isRuleArray(c.after) ? ruleText(c.after) : c.after,
      }
    }
  }
  return logs
}
