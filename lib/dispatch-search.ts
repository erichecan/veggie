export interface DriverDispatchSearch {
  driverName: string
  batch: number
  timeOfDay: 'am' | 'pm'
}

const SHIFT_WORDS: Record<string, 'am' | 'pm'> = {
  am: 'am', morning: 'am', 上午: 'am', 早上: 'am',
  pm: 'pm', afternoon: 'pm', 下午: 'pm',
}
const FILLER_WORDS = new Set(['batch', 'driver', 'shift', 'delivery', 'time'])
const tokenize = (value: string) => value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.map(token => token.toLowerCase()) ?? []

/**
 * Recognizes one complete driver assignment phrase in any word order, e.g.
 * `1 am ANDRIUS`, `ANDRIUS AM 1`, or `driver Andrius batch 1 morning`.
 * Names are matched against configured driver names; partial or ambiguous input returns null.
 */
export function parseDriverDispatchSearch(raw: string, driverNames: string[]): DriverDispatchSearch | null {
  const words = tokenize(raw)
  if (words.length < 3) return null

  const uniqueNames = new Map<string, string>()
  for (const name of driverNames) {
    const trimmed = name.trim()
    const nameWords = tokenize(trimmed)
    if (nameWords.length > 0 && !uniqueNames.has(nameWords.join(' '))) uniqueNames.set(nameWords.join(' '), trimmed)
  }

  const matches: DriverDispatchSearch[] = []
  for (const [normalizedName, driverName] of uniqueNames) {
    const nameWords = normalizedName.split(' ')
    for (let start = 0; start <= words.length - nameWords.length; start++) {
      if (!nameWords.every((word, offset) => words[start + offset] === word)) continue

      const remaining = words.filter((_, index) => index < start || index >= start + nameWords.length)
        .filter(word => !FILLER_WORDS.has(word))
      const shifts = remaining.filter(word => word in SHIFT_WORDS)
      const batches = remaining.filter(word => /^\d+$/.test(word))
      const unrecognized = remaining.filter(word => !(word in SHIFT_WORDS) && !/^\d+$/.test(word))
      if (shifts.length !== 1 || batches.length !== 1 || unrecognized.length > 0) continue

      const batch = Number(batches[0])
      if (!Number.isSafeInteger(batch) || batch < 1) continue
      matches.push({ driverName, batch, timeOfDay: SHIFT_WORDS[shifts[0]] })
    }
  }

  const distinctMatches = new Map(matches.map(match => [
    `${match.driverName.normalize('NFKC').toLowerCase()}|${match.batch}|${match.timeOfDay}`,
    match,
  ]))
  return distinctMatches.size === 1 ? [...distinctMatches.values()][0] : null
}
