/**
 * 下拉搜索的相关性排序。
 *
 * 在保持"子串匹配"的前提下，按相关度分层排序，让"更像你输入的"排在前面：
 *   0 完全等于   →   1 整串前缀   →   2 单词前缀   →   3 中间包含
 * 同层内按主文本字母序。不匹配的项被过滤掉；query 为空时原样返回（不排序）。
 *
 * getTexts 可返回单个字符串，或多个候选字符串（如商品名 + 内部编号），取最优层级。
 */
const WORD_SEP = /[\s\-_/.,()]+/

export function rankByRelevance<T>(
  items: T[],
  query: string,
  getTexts: (item: T) => string | Array<string | null | undefined>,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items

  const scoreText = (text: string): number => {
    const n = text.toLowerCase()
    if (n === q) return 0
    if (n.startsWith(q)) return 1
    if (n.split(WORD_SEP).some(w => w.startsWith(q))) return 2
    if (n.includes(q)) return 3
    return 99
  }

  return items
    .map(item => {
      const raw = getTexts(item)
      const texts = (Array.isArray(raw) ? raw : [raw]).filter((t): t is string => !!t)
      const score = texts.reduce((min, t) => Math.min(min, scoreText(t)), 99)
      return { item, score, primary: texts[0] ?? '' }
    })
    .filter(x => x.score < 99)
    .sort((a, b) => a.score - b.score || a.primary.localeCompare(b.primary))
    .map(x => x.item)
}
