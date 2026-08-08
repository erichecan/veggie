/**
 * 登录失败节流：按**账号**计数并临时锁定。
 * ============================================================================
 * 与 `lib/rate-limit.ts` 的区别，也是加这一层的唯一理由：
 *
 *   rate-limit 按**来源 IP** 分桶 —— 换个 IP 就重新开始。对着一个账号跑字典，
 *   只要来源分散（代理池、僵尸网络、甚至手机切流量），10 次/分钟形同虚设。
 *
 * 这一层按**邮箱**分桶，与来源无关：同一个账号连续失败到阈值就锁一段时间，
 * 攻击者换多少个 IP 都绕不过去。
 *
 * ⚠️ 两个有意为之的取舍：
 *
 * 1. **锁定只影响该账号，不影响别人。** 按 IP 锁会误伤同一出口下的同事
 *    （客户是一个办公室，大概率共用一个公网 IP）。
 *
 * 2. **锁定期内即使密码正确也拒绝。** 否则攻击者可以用「响应变了」判断出
 *    自己刚才蒙对了密码 —— 锁定反而成了一个预言机。
 *
 * 状态在进程内存里。当前 droplet 是单实例，够用；将来水平扩展要换共享存储，
 * 否则每个实例各算各的，实际阈值 = 实例数 × 阈值。已登记在
 * docs/20260807-production-credentials-audit.md 的上线后待办里。
 */

/** 连续失败多少次开始锁 */
const FAIL_THRESHOLD = 5
/** 锁多久（毫秒）。递增：第 n 次触发锁 n 倍时长，上限 30 分钟 */
const BASE_LOCK_MS = 60_000
const MAX_LOCK_MS = 30 * 60_000
/** 多久没有失败就把计数清零 —— 免得昨天的 2 次失败和今天的 3 次凑成锁定 */
const FAIL_WINDOW_MS = 15 * 60_000

interface Entry {
  fails: number
  lastFailAt: number
  /** 已经触发过几次锁定，用于递增时长 */
  lockCount: number
  lockedUntil: number
}

const entries = new Map<string, Entry>()

/** 邮箱大小写不敏感，别让 Foo@x.com 和 foo@x.com 各算各的 */
const keyOf = (email: string) => email.trim().toLowerCase()

function pruneStale(now: number): void {
  // 顺手清理，避免 Map 无限增长（攻击者可以用海量随机邮箱撑内存）
  if (entries.size < 5000) return
  for (const [k, e] of entries) {
    if (e.lockedUntil < now && now - e.lastFailAt > FAIL_WINDOW_MS) entries.delete(k)
  }
}

export interface LockState {
  locked: boolean
  /** 还要等多少秒 */
  retryAfterSec: number
}

/** 登录前查：这个账号现在是不是被锁着 */
export function checkLocked(email: string, now = Date.now()): LockState {
  const e = entries.get(keyOf(email))
  if (!e || e.lockedUntil <= now) return { locked: false, retryAfterSec: 0 }
  return { locked: true, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) }
}

/**
 * 记一次失败。返回记完之后的锁定状态。
 *
 * 注意「账号不存在」也要记 —— 否则响应时间/行为差异会把「这个邮箱存在吗」
 * 泄露出去，等于送一份用户名枚举。
 */
export function recordFailure(email: string, now = Date.now()): LockState {
  pruneStale(now)
  const k = keyOf(email)
  const e = entries.get(k) ?? { fails: 0, lastFailAt: 0, lockCount: 0, lockedUntil: 0 }

  // 距上次失败太久，重新计数
  if (now - e.lastFailAt > FAIL_WINDOW_MS) e.fails = 0

  e.fails += 1
  e.lastFailAt = now

  if (e.fails >= FAIL_THRESHOLD) {
    e.lockCount += 1
    const lockMs = Math.min(BASE_LOCK_MS * e.lockCount, MAX_LOCK_MS)
    e.lockedUntil = now + lockMs
    e.fails = 0                      // 锁上之后重新数，解锁后再失败 5 次会锁更久
  }

  entries.set(k, e)
  return checkLocked(email, now)
}

/** 登录成功：清零。lockCount 一并清掉，不然正常用户偶尔打错也会越锁越久 */
export function recordSuccess(email: string): void {
  entries.delete(keyOf(email))
}

/** 测试用 */
export function resetLoginThrottle(): void {
  entries.clear()
}

export const LOGIN_THROTTLE_CONFIG = {
  FAIL_THRESHOLD,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  FAIL_WINDOW_MS,
} as const
