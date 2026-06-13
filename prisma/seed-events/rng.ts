/**
 * 可复现伪随机 + 确定性工具
 * ============================================================================
 * 固定 seed 的 PRNG（mulberry32），保证每次 seed 产出同一套数据。
 * 字符串哈希用于「由实体 id 派生稳定画像」——同一客户每次都得到同一层级/常买清单。
 */

/** mulberry32：32 位种子 → [0,1) 浮点流 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 字符串哈希 → 无符号 32 位整数（确定性） */
export function strHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class Rng {
  private next: () => number
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }
  /** [0,1) */
  float(): number {
    return this.next()
  }
  /** [min,max] 闭区间整数 */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }
  /** [min,max) 浮点，保留 2 位 */
  money(min: number, max: number): number {
    return Math.round((this.next() * (max - min) + min) * 100) / 100
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]
  }
  /** 概率 p 命中 */
  chance(p: number): boolean {
    return this.next() < p
  }
  /** 不放回抽 n 个 */
  pickN<T>(arr: readonly T[], n: number): T[] {
    const copy = [...arr]
    const out: T[] = []
    for (let i = 0; i < n && copy.length > 0; i++) {
      out.push(copy.splice(Math.floor(this.next() * copy.length), 1)[0])
    }
    return out
  }
  /** 加权选择：weights[i] 对应 items[i] */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0)
    let r = this.next() * total
    for (let i = 0; i < items.length; i++) {
      r -= weights[i]
      if (r <= 0) return items[i]
    }
    return items[items.length - 1]
  }
}

/** 由字符串确定性地从数组取一个（同一 key 永远同一结果） */
export function stablePick<T>(key: string, arr: readonly T[]): T {
  return arr[strHash(key) % arr.length]
}

/** 由字符串确定性返回 [0,1) */
export function stableFloat(key: string): number {
  return (strHash(key) % 100000) / 100000
}

export const round2 = (n: number): number => Math.round(n * 100) / 100
export const round3 = (n: number): number => Math.round(n * 1000) / 1000
