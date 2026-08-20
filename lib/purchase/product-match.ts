/**
 * 导入行 → 系统商品的匹配（20260819 重写）
 * ============================================================================
 * 取代 `lib/import-parser.ts` 里的 `matchProducts`。旧实现是**双向子串包含**：
 *
 *     p.name.includes(query) || query.includes(p.name)
 *
 * 后半截是灾难。实测（20260819，生产库快照）：供应商单上的 `Harvest Beans`
 * 被匹配成商品 **`vest`** —— 因为 `"harvestbeans".includes("vest")` 为真，
 * 而库里躺着 `vest` / `osp` / `prok` / `reuse` / `0` 这类历史测试垃圾商品，
 * 其中 `vest` 恰好排在商品列表第 1 位，`find()` 一取就是它。
 * 更糟的是旧路径把它标成 `fuzzy`（不是 `none`）并**直接建单落库**。
 *
 * 所以这里有三条硬规则：
 *
 * 1. **只做「查询词覆盖商品名」的正向判定，绝不反过来。** 商品名是不是查询串的
 *    子串，这个方向没有任何业务含义 —— 它唯一的作用就是让短名商品变成万能匹配器。
 * 2. **按 token 比，不按字符串比。** 去掉空格拼成一坨之后 `vest` 就藏进了
 *    `harvest`；按词切开之后 `harvest` ≠ `vest`，问题自然消失。
 * 3. **命中多个时不许闷头取第一个。** 生产库有 70 组同名可采购商品、
 *    `Courgette` 一个词命中 4 个（CASE/LOOSE/Slice KG/Mix Cut）。
 *    歧义必须显式返回候选列表交给人挑，不能替人做决定。
 */

/** 单位后缀：比价时忽略它，否则 `Courgette` 永远配不上 `Courgette LOOSE` */
const UNIT_SUFFIX = new Set([
  'case', 'pkt', 'packet', 'pack', 'pk', 'bag', 'kg', 'g', 'loose', 'box',
  'jar', 'tin', 'bottle', 'drum', 'punnet', 'tray', 'bucket', 'pallet',
  'each', 'tub', 'roll', 'single', 'pcs', 'unit', 'units',
])

/** 切词：小写、把标点与连续空白都当分隔符。保留中日韩字符（商品名里有中文别名） */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** 去掉纯单位词与纯数字规格，留下真正标识商品的词 */
function significantTokens(tokens: string[]): string[] {
  const sig = tokens.filter(t => !UNIT_SUFFIX.has(t) && !/^\d+$/.test(t))
  // 全被过滤光了（如商品就叫 "KG"）就退回原始 token，总得有东西可比
  return sig.length > 0 ? sig : tokens
}

/** 归一化整串：小写 + 连续空白压成一个空格 + 去首尾。生产库有 69 个商品名含连续空格 */
export function normalizeName(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none'

export interface MatchCandidate {
  id: string
  name: string
  /** 0–1，查询词被商品名覆盖的比例 */
  score: number
}

export interface MatchedLine {
  matchedProductId: string | null
  matchedProductName: string | null
  confidence: MatchConfidence
  /** 命中多个时的候选（含被选中的那个），最多 5 个，供界面让人改选 */
  candidates: MatchCandidate[]
  /** true = 有多个同分候选，界面必须提示人工确认 */
  ambiguous: boolean
}

export interface MatchableProduct {
  id: string
  name: string
  internalRef?: string | null
}

/** 覆盖率达到多少才算 strong（可自动填入，但仍标出来给人看） */
const STRONG_THRESHOLD = 1
/** 低于这个覆盖率直接判 none —— 宁可让人手挑，也不要塞一个错的进去 */
const WEAK_THRESHOLD = 0.6

/**
 * 单行匹配。
 * 打分只看「查询里的有效词有多少被商品名覆盖」，不看商品名有多长 ——
 * 供应商单上写 `Courgette`，库里 `Courgette CASE` 与 `Courgette LOOSE` 同分，
 * 这**本来就该**是歧义，不该由长度差随便挑一个。
 */
export function matchOne(rawName: string, products: MatchableProduct[]): MatchedLine {
  const none: MatchedLine = {
    matchedProductId: null, matchedProductName: null,
    confidence: 'none', candidates: [], ambiguous: false,
  }

  const query = normalizeName(rawName)
  if (!query) return none

  // 内部编号命中一律优先：它是唯一键，比名字可靠
  const refHit = products.find(p => p.internalRef && normalizeName(p.internalRef) === query)
  if (refHit) {
    return {
      matchedProductId: refHit.id, matchedProductName: refHit.name,
      confidence: 'exact', candidates: [{ id: refHit.id, name: refHit.name, score: 1 }], ambiguous: false,
    }
  }

  const exact = products.filter(p => normalizeName(p.name) === query)
  if (exact.length === 1) {
    return {
      matchedProductId: exact[0].id, matchedProductName: exact[0].name,
      confidence: 'exact', candidates: [{ id: exact[0].id, name: exact[0].name, score: 1 }], ambiguous: false,
    }
  }
  if (exact.length > 1) {
    // 同名商品在生产库有 70 组，名字一样就是分不出来，必须交给人
    return {
      matchedProductId: null, matchedProductName: null, confidence: 'none',
      candidates: exact.slice(0, 5).map(p => ({ id: p.id, name: p.name, score: 1 })),
      ambiguous: true,
    }
  }

  const queryTokens = significantTokens(tokenize(query))
  if (queryTokens.length === 0) return none

  // 单据上常见「英文名 + 中文别名」并排（实测客户单据的文字层就是
  // `Courgette LOOSE` 换行接 `角瓜`，解析器把两行合成 `Courgette LOOSE 角瓜`）。
  // 商品库里的名字基本是纯英文，中文别名一个都对不上 ——
  // 按全部词算覆盖率，`courgette` 命中 1/2 = 0.5 直接被判 none，明明该匹配上。
  // 所以拉丁词单独再算一次，取两者较高的。放松的只是"别名不算数"，
  // 不会放宽实质匹配：`Harvest Beans` 的拉丁词是 [harvest, beans]，
  // 对商品 `vest` 仍然一个都不命中。
  const latinTokens = queryTokens.filter(t => /^[a-z0-9]+$/.test(t))
  const useLatinToo = latinTokens.length > 0 && latinTokens.length < queryTokens.length

  /**
   * 单位词不参与打分，但**参与区分**。
   * 生产库里 `Courgette CASE` / `Courgette LOOSE` / `Courgette Slice KG` 并存，
   * 把单位词一起丢掉之后三者对查询 `Courgette LOOSE 角瓜` 同分，全成了歧义 ——
   * 而单据明明写了 LOOSE。所以它降级成 tie-break：同分时，单位对得上的胜出。
   */
  const queryUnits = new Set(tokenize(query).filter(t => UNIT_SUFFIX.has(t)))

  const scored: Array<MatchCandidate & { unitHit: boolean }> = []
  for (const p of products) {
    const nameTokenList = tokenize(p.name)
    const nameTokens = new Set(nameTokenList)
    if (nameTokens.size === 0) continue
    const hitAll = queryTokens.filter(t => nameTokens.has(t)).length
    let score = hitAll / queryTokens.length
    if (useLatinToo) {
      const hitLatin = latinTokens.filter(t => nameTokens.has(t)).length
      score = Math.max(score, hitLatin / latinTokens.length)
    }
    if (score < WEAK_THRESHOLD) continue
    const unitHit = queryUnits.size > 0 && nameTokenList.some(t => queryUnits.has(t))
    scored.push({ id: p.id, name: p.name, score, unitHit })
  }

  if (scored.length === 0) return none

  // 排序：覆盖率 → 单位是否对得上 → 名字短的在前（`Courgette` 更可能指
  // `Courgette LOOSE` 而不是 `Onion Diced+Courgette Mix Cut`）
  scored.sort((a, b) =>
    b.score - a.score
    || Number(b.unitHit) - Number(a.unitHit)
    || a.name.length - b.name.length
    || a.name.localeCompare(b.name),
  )

  const top = scored[0]
  // 歧义判定要把单位一起算进去：同覆盖率但只有一个单位对得上时，那个就是答案
  const tied = scored.filter(c => c.score === top.score && c.unitHit === top.unitHit)
  const ambiguous = tied.length > 1
  const confidence: MatchConfidence = top.score >= STRONG_THRESHOLD ? 'strong' : 'weak'

  return {
    // 有歧义就不替人做主：留空让界面强制人工挑
    matchedProductId: ambiguous ? null : top.id,
    matchedProductName: ambiguous ? null : top.name,
    confidence: ambiguous ? 'none' : confidence,
    candidates: scored.slice(0, 5).map(({ id, name, score }) => ({ id, name, score })),
    ambiguous,
  }
}

export interface MatchStats {
  total: number
  exact: number
  strong: number
  weak: number
  none: number
  ambiguous: number
}

export function matchStats(lines: MatchedLine[]): MatchStats {
  return {
    total: lines.length,
    exact: lines.filter(l => l.confidence === 'exact').length,
    strong: lines.filter(l => l.confidence === 'strong').length,
    weak: lines.filter(l => l.confidence === 'weak').length,
    none: lines.filter(l => l.confidence === 'none').length,
    ambiguous: lines.filter(l => l.ambiguous).length,
  }
}
