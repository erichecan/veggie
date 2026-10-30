/**
 * 价格表规则(OdooPricelist.items)的逐条改价留痕 —— 20261008
 * ============================================================================
 * 以前 PUT /api/pricelists/[id] 只记「items 12 → 13」，改了哪条规则、从几块改成几块
 * 都查不到；批量导入更是只有一条汇总日志。这里把前后两份 items 按规则 id 对齐，
 * 产出每条规则的 新增 / 删除 / 价格字段变化，供两处使用：
 *   1. 价格表自己的操作记录(chatter)：changes 里每个价格字段一条 before → after；
 *   2. 商品页「价格表」区块的改价历史：按商品另写一条 resource='pricelist-rule'、
 *      resourceId=商品 id 的日志(见 ruleLogsByProduct)，商品页直接按商品 id 查。
 */
import type { PricelistItemInput } from './pricelist-item'

/** 影响成交价的字段；sequence / badgeLabel 这类纯展示字段不算改价
 *  20261017：selectable 也算——关掉它等同于把这条规则从定价里摘掉(lib/pricing-engine.ts
 *  matchesItem 直接跳过)，效果跟删规则一样，必须留痕，否则客户成交价静默变了却查不到改价历史 */
export const RULE_PRICE_FIELDS = [
  'computeType', 'fixedPrice', 'percentDiscount', 'formulaBase', 'basedOnPricelistId',
  'priceDiscount', 'priceSurcharge', 'priceMinMargin', 'priceMaxMargin', 'roundingMethod',
  'minQty', 'dateStart', 'dateEnd', 'uomId', 'selectable',
] as const

export type RuleChangeKind = 'added' | 'removed' | 'changed'

export interface RuleChange {
  itemId: string
  kind: RuleChangeKind
  applyOn: string
  /** 规则锁定的商品(product/variant)；分类/全场规则为 null */
  productId: string | null
  categoryId: string | null
  /** added/removed 时为空；changed 时是变化的价格字段 */
  fields: Record<string, { before: unknown; after: unknown }>
  before?: PricelistItemInput
  after?: PricelistItemInput
}

/** variant / product 都指向 Product.id(见 lib/pricing-engine.ts) */
export function ruleProductId(it: Partial<PricelistItemInput> | null | undefined): string | null {
  if (!it) return null
  if (it.applyOn === 'variant') return it.productVariantId || it.productTemplateId || null
  if (it.applyOn === 'product') return it.productTemplateId || it.productVariantId || null
  return null
}

function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && !/^\d{4}-/.test(v)) return Number(v)
  return v
}

/** uomId -> 单位名(如 "CASE")的查找函数；不传时退化成不显示单位(旧行为) */
export type UomLabeler = (uomId: string) => string | undefined

/** 规则的价格一句话描述：「Fixed 12.5」「-10%」「Formula: list_price -5% +0.5」
 *  20261024：同一商品的 CASE 规则和 PACK 规则只要公式参数一样，摘要文字就完全相同，
 *  操作记录里分不出改的是哪条(客户反馈：「看不出来改了什么」)。uomLabel 能解析时把单位名带上。 */
export function ruleSummary(it: Partial<PricelistItemInput> | null | undefined, uomLabel?: UomLabeler): string {
  if (!it) return ''
  const minQty = Number(it.minQty ?? 0)
  const qty = minQty > 0 ? ` (≥${minQty})` : ''
  const unit = it.uomId ? ` · ${uomLabel?.(it.uomId) ?? it.uomId}` : ''
  if (it.computeType === 'fixed') return `Fixed ${Number(it.fixedPrice ?? 0)}${qty}${unit}`
  if (it.computeType === 'percentage') return `${-Number(it.percentDiscount ?? 0)}%${qty}${unit}`
  const parts = [`Formula: ${it.formulaBase ?? 'list_price'}`]
  if (Number(it.priceDiscount ?? 0) !== 0) parts.push(`${-Number(it.priceDiscount)}%`)
  if (Number(it.priceSurcharge ?? 0) !== 0) parts.push(`${Number(it.priceSurcharge) > 0 ? '+' : ''}${Number(it.priceSurcharge)}`)
  return parts.join(' ') + qty + unit
}

/** 单条规则的价格字段 diff(只含变化的字段) */
export function diffRule(before: Partial<PricelistItemInput>, after: Partial<PricelistItemInput>): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {}
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  for (const f of RULE_PRICE_FIELDS) {
    const bv = norm(b[f])
    const av = norm(a[f])
    if (JSON.stringify(bv) !== JSON.stringify(av)) out[f] = { before: bv, after: av }
  }
  return out
}

function asItems(raw: unknown): PricelistItemInput[] {
  return Array.isArray(raw) ? (raw as PricelistItemInput[]).filter(it => it && typeof it === 'object') : []
}

/** 前后两份 items 按规则 id 对齐，返回新增 / 删除 / 价格字段有变化的规则 */
export function diffPricelistItems(beforeRaw: unknown, afterRaw: unknown): RuleChange[] {
  const before = asItems(beforeRaw)
  const after = asItems(afterRaw)
  const beforeById = new Map<string, PricelistItemInput>()
  for (const it of before) if (it.id) beforeById.set(it.id, it)
  const afterIds = new Set(after.map(it => it.id).filter((v): v is string => !!v))

  const out: RuleChange[] = []
  for (const it of after) {
    const prev = it.id ? beforeById.get(it.id) : undefined
    const base = { itemId: it.id ?? '', applyOn: it.applyOn, productId: ruleProductId(it), categoryId: it.applyOn === 'category' ? it.categoryId ?? null : null }
    if (!prev) {
      out.push({ ...base, kind: 'added', fields: {}, after: it })
      continue
    }
    const fields = diffRule(prev, it)
    // 规则改挂到了别的商品/分类上：对旧目标是"删除"，对新目标是"新增"，商品页两边都能看到
    const prevProduct = ruleProductId(prev)
    if (prevProduct !== base.productId || (prev.applyOn === 'category' ? prev.categoryId ?? null : null) !== base.categoryId || prev.applyOn !== it.applyOn) {
      out.push({ itemId: prev.id ?? '', kind: 'removed', applyOn: prev.applyOn, productId: prevProduct, categoryId: prev.applyOn === 'category' ? prev.categoryId ?? null : null, fields: {}, before: prev })
      out.push({ ...base, kind: 'added', fields: {}, after: it })
      continue
    }
    if (Object.keys(fields).length > 0) out.push({ ...base, kind: 'changed', fields, before: prev, after: it })
  }
  for (const it of before) {
    if (it.id && afterIds.has(it.id)) continue
    out.push({
      itemId: it.id ?? '', kind: 'removed', applyOn: it.applyOn, productId: ruleProductId(it),
      categoryId: it.applyOn === 'category' ? it.categoryId ?? null : null, fields: {}, before: it,
    })
  }
  return out
}

/**
 * 不影响成交价、但操作记录里要看得见的规则变化：拖拽排序(sequence)、徽标(badgeLabel)。
 * 不进 RULE_PRICE_FIELDS——那份还驱动商品页改价历史，排序/徽标不算改价。
 */
export function diffItemDisplayFields(beforeRaw: unknown, afterRaw: unknown): { reordered: boolean; badgeChanges: RuleChange[] } {
  const before = asItems(beforeRaw)
  const after = asItems(afterRaw)
  const beforeById = new Map(before.filter(it => it.id).map(it => [it.id as string, it]))
  const common = after.filter(it => it.id && beforeById.has(it.id))
  const order = (items: PricelistItemInput[]) => [...items].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)).map(it => it.id).join('|')
  const reordered = order(common) !== order(common.map(it => beforeById.get(it.id as string)!))

  const badgeChanges: RuleChange[] = []
  for (const it of common) {
    const prev = beforeById.get(it.id as string)!
    const bv = norm(prev.badgeLabel)
    const av = norm(it.badgeLabel)
    if (bv === av) continue
    badgeChanges.push({
      itemId: it.id as string, kind: 'changed', applyOn: it.applyOn, productId: ruleProductId(it),
      categoryId: it.applyOn === 'category' ? it.categoryId ?? null : null,
      fields: { badgeLabel: { before: bv, after: av } }, before: prev, after: it,
    })
  }
  return { reordered, badgeChanges }
}

const SUMMARY_NAME_LIMIT = 3

/**
 * 操作记录标题里的一句话，点名是哪几条规则：
 * 「新增规则：Apple [#12]；修改规则：Corn Flour [#67]、Category Fruit 等 5 条；调整了规则排序」。
 * 每类最多点 3 个名字，具体改了哪个字段、从多少到多少在展开的 changes 里。什么都没变返回空串。
 */
export function summarizePricelistUpdate(
  ruleChanges: RuleChange[], reordered: boolean, badgeChanges: RuleChange[], settingsChanged: number, label: RuleTargetLabeler,
): string {
  const names = (list: RuleChange[]) => {
    const unique = [...new Map(list.map(c => [c.itemId, label(c)])).values()]
    const shown = [...new Set(unique)].slice(0, SUMMARY_NAME_LIMIT).join('、')
    return unique.length > SUMMARY_NAME_LIMIT ? `${shown} 等 ${unique.length} 条` : shown
  }
  const added = ruleChanges.filter(c => c.kind === 'added')
  const changed = [...ruleChanges.filter(c => c.kind === 'changed'), ...badgeChanges]
  const removed = ruleChanges.filter(c => c.kind === 'removed')
  const parts: string[] = []
  if (added.length) parts.push(`新增规则：${names(added)}`)
  if (changed.length) parts.push(`修改规则：${names(changed)}`)
  if (removed.length) parts.push(`删除规则：${names(removed)}`)
  if (reordered) parts.push('调整了规则排序')
  if (settingsChanged > 0) parts.push('修改了价格表设置')
  return parts.join('；')
}

/** 规则的对象名，用作 chatter 里的字段前缀：「Apple [#12]」「Category Fruit」「All Products」 */
export type RuleTargetLabeler = (c: Pick<RuleChange, 'applyOn' | 'productId' | 'categoryId'>) => string

/**
 * 把规则变化摊平成 ActionLog.changes：key 是「对象 · 字段」(chatter 的 fieldLabel 会翻译
 * 「·」后面的字段名)，value 是 {before, after}。新增/删除的规则用「对象 · rule」+ 价格描述。
 * 条数太多时截断，最后补一条 more 计数，避免一次大改把一条日志撑到几百 KB。
 */
export function ruleChangesToLogChanges(
  changes: RuleChange[],
  label: RuleTargetLabeler,
  uomLabel?: UomLabeler,
  limit = 60,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {}
  let n = 0
  let truncated = 0
  for (const c of changes) {
    const entries: Array<[string, { before: unknown; after: unknown }]> = c.kind === 'changed'
      ? Object.entries(c.fields)
      : [['rule', c.kind === 'added' ? { before: null, after: ruleSummary(c.after, uomLabel) } : { before: ruleSummary(c.before, uomLabel), after: null }]]
    for (const [field, v] of entries) {
      if (n >= limit) { truncated++; continue }
      let key = `${label(c)} · ${field}`
      // 同一对象可能有多条规则(不同最小数量/日期)：撞 key 时补序号，不能互相覆盖
      for (let i = 2; key in out; i++) key = `${label(c)} (${i}) · ${field}`
      out[key] = v
      n++
    }
  }
  if (truncated > 0) out.moreRuleChanges = { before: null, after: truncated }
  return out
}

export interface ProductRuleLog {
  productId: string
  changes: Record<string, { before: unknown; after: unknown }>
  kinds: Set<RuleChangeKind>
}

/**
 * 按商品分组，给商品页的改价历史用：每个商品一条日志，key 是「价格表名 · 字段」。
 * 分类/全场规则不落到具体商品上(一改就是几千个商品，写不过来)，只记在价格表自己的 chatter。
 */
export function ruleLogsByProduct(changes: RuleChange[], pricelistName: string, uomLabel?: UomLabeler): ProductRuleLog[] {
  const byProduct = new Map<string, ProductRuleLog>()
  for (const c of changes) {
    if (!c.productId) continue
    let entry = byProduct.get(c.productId)
    if (!entry) { entry = { productId: c.productId, changes: {}, kinds: new Set() }; byProduct.set(c.productId, entry) }
    entry.kinds.add(c.kind)
    const qty = Number((c.after ?? c.before)?.minQty ?? 0)
    const prefix = qty > 0 ? `${pricelistName} (≥${qty})` : pricelistName
    const entries: Array<[string, { before: unknown; after: unknown }]> = c.kind === 'changed'
      ? Object.entries(c.fields)
      : [['rule', c.kind === 'added' ? { before: null, after: ruleSummary(c.after, uomLabel) } : { before: ruleSummary(c.before, uomLabel), after: null }]]
    for (const [field, v] of entries) {
      let key = `${prefix} · ${field}`
      for (let i = 2; key in entry.changes; i++) key = `${prefix} (${i}) · ${field}`
      entry.changes[key] = v
    }
  }
  return [...byProduct.values()]
}

/** 商品日志的 detail(中文写库，显示时 lib/action-log-i18n.ts 翻译) */
export function productRuleLogDetail(pricelistName: string, kinds: Set<RuleChangeKind>, via?: string): string {
  const what = kinds.has('changed') || (kinds.has('added') && kinds.has('removed'))
    ? '价格规则修改'
    : kinds.has('added') ? '价格规则新增' : '价格规则删除'
  return `${what}: ${pricelistName}${via ? ` (${via})` : ''}`
}
