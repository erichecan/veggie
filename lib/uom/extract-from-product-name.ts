/**
 * 从商品名提炼计量单位（20260819）
 * ============================================================================
 * 客户原话：「我看到实际生产库里的商品名后面都是有一个后缀的，比如 case、kg 等等
 * 计量单位信息，所以现在的计量单位管理这里，与其自己编造，不如直接从商品名里全部
 * 提炼出来，这样更符合客户原来的商品管理规则」。
 *
 * 生产库实测（20260819）支持这个判断：ACTIVE 可售商品 1736 个里，
 * 末词是 CASE 的 1002 个、PKT 325 个、BAG 50、KG 50、LOOSE 33 …
 * 全库 93.9% 的商品名末词是纯字母。单位信息本来就在名字里。
 *
 * 现在的单位表则是自造的：箱/袋/头/盒/板/筐/把/扎 这类中文词客户从来不用，
 * 客户在那个 tiger shrimp 上配规格时只能从里面挑一个「头」——因为没有 PKT 可选。
 *
 * ## 这里只提炼**名字**，不提炼系数
 *
 * 20260819 起换算系数挂在 `ProductSaleUom.factor`（每个商品自己的箱规），
 * 全局单位不再需要 factor —— 这正是「从商品名提炼」变得可行的前提：
 * 名字里的 `CASE` 在不同商品上箱规不同，但作为**名字**它是同一个。
 *
 * ## 判据
 *
 * 1. 只看末词，且必须是纯字母（含 `'` `.`）。`700g` / `10*700g` / `2.5KG`
 *    是**规格**不是单位，带数字一律排除。
 * 2. 大写归一：`JAR`/`Jar`、`BAG`/`Bag`、`KG`/`Kg`/`kg` 是同一个单位的三种写法。
 * 3. 已知拼写错误直接改正（`PUNNUT`/`PUNNT` → `PUNNET`，生产库里两种错拼共 11 个）。
 * 4. 低频末词多半不是单位而是普通词（`Cut`、`Mix`、`Only`），
 *    所以要么在白名单里，要么出现次数达到阈值，才认定为单位。
 */

/** 已知拼写变体 → 规范写法。左侧全大写 */
const SPELLING_FIX: Record<string, string> = {
  PUNNUT: 'PUNNET',
  PUNNT: 'PUNNET',
  PUNET: 'PUNNET',
  PACKET: 'PACKET',
  PKT: 'PKT',
}

/**
 * 确定是单位的词（不论出现几次都收）。
 * 来自生产库末词频次表的高频项 + 行业通用包装词。
 */
const KNOWN_UNITS = new Set([
  'CASE', 'PKT', 'PACKET', 'PACK', 'PK', 'BAG', 'KG', 'G', 'LOOSE', 'BOX',
  'JAR', 'TIN', 'BOTTLE', 'DRUM', 'PUNNET', 'TRAY', 'BUCKET', 'PALLET',
  'EACH', 'TUB', 'ROLL', 'SINGLE', 'PCS', 'UNIT', 'L', 'ML', 'BLOCK', 'CTN',
])

/**
 * 明确不是单位的末词 —— 它们碰巧出现在名字末尾，收进单位表只会制造垃圾。
 * 全部来自生产库实际数据。
 */
const NOT_UNITS = new Set([
  'REUSE', 'REUSEABLE', 'USE', 'DIFFERENCE', 'TEST', 'TESTING', 'DEMO',
  'ONLY', 'CUT', 'MIX', 'FREE', 'NEW', 'OLD', 'SERVICE', 'RATE', 'DISCOUNT',
])

/** 低于这个出现次数、又不在白名单里的末词，不认定为单位 */
export const DEFAULT_MIN_COUNT = 3

export interface ExtractOptions {
  /** 低频末词的收录门槛 */
  minCount?: number
}

export interface ExtractedUnit {
  /** 规范写法（全大写） */
  name: string
  /** 归一到它的所有原始写法及各自出现次数 */
  variants: Array<{ raw: string; count: number }>
  /** 合计出现次数 */
  count: number
}

export interface ExtractResult {
  units: ExtractedUnit[]
  /** 末词不是纯字母（多半是 `700g` `10*700g` 这类规格）的商品数 */
  skippedNumeric: number
  /** 末词是纯字母但被判为非单位的，附带样例供人核对判据是否过严 */
  rejected: Array<{ name: string; count: number }>
  totalProducts: number
}

/** 取商品名的末词。连续空白按单个空白处理（生产库有 69 个名字带双空格） */
export function lastToken(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ')
  const idx = t.lastIndexOf(' ')
  return idx === -1 ? t : t.slice(idx + 1)
}

/** 纯字母（允许撇号与点，覆盖 `100's` 这类写法里的字母部分） */
function isAlphaToken(tok: string): boolean {
  return /^[A-Za-z][A-Za-z'.]*$/.test(tok)
}

/** 归一：去掉尾部标点 → 全大写 → 修正已知拼写 */
export function canonicalize(tok: string): string {
  const upper = tok.replace(/[.'"]+$/, '').toUpperCase()
  return SPELLING_FIX[upper] ?? upper
}

/**
 * 从一批商品名里提炼单位表。
 * 纯函数、无 IO —— 脚本与测试用同一份判据。
 */
export function extractUnits(productNames: string[], options: ExtractOptions = {}): ExtractResult {
  const minCount = options.minCount ?? DEFAULT_MIN_COUNT

  const byCanonical = new Map<string, Map<string, number>>()
  let skippedNumeric = 0

  for (const name of productNames) {
    const tok = lastToken(name ?? '')
    if (!tok) continue
    if (!isAlphaToken(tok)) { skippedNumeric++; continue }
    const canon = canonicalize(tok)
    if (!byCanonical.has(canon)) byCanonical.set(canon, new Map())
    const variants = byCanonical.get(canon)!
    variants.set(tok, (variants.get(tok) ?? 0) + 1)
  }

  const units: ExtractedUnit[] = []
  const rejected: Array<{ name: string; count: number }> = []

  for (const [canon, variants] of byCanonical) {
    const count = [...variants.values()].reduce((a, b) => a + b, 0)
    const accepted = KNOWN_UNITS.has(canon)
      || (!NOT_UNITS.has(canon) && count >= minCount)
    if (!accepted) { rejected.push({ name: canon, count }); continue }
    if (NOT_UNITS.has(canon)) { rejected.push({ name: canon, count }); continue }
    units.push({
      name: canon,
      count,
      variants: [...variants.entries()]
        .map(([raw, c]) => ({ raw, count: c }))
        .sort((a, b) => b.count - a.count),
    })
  }

  units.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  rejected.sort((a, b) => b.count - a.count)

  return { units, skippedNumeric, rejected, totalProducts: productNames.length }
}

/** 提炼出来的单位覆盖了多少比例的商品 */
export function coverage(result: ExtractResult): number {
  if (result.totalProducts === 0) return 0
  const covered = result.units.reduce((sum, u) => sum + u.count, 0)
  return covered / result.totalProducts
}
