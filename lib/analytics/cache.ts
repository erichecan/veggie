/**
 * 分析类接口的进程内响应缓存
 * ============================================================================
 * 为什么值得做：`/api/analytics/*` 的输入是**已完成的历史订单**，同一组参数在
 * 几分钟内必然算出同样的结果。而这台机器只有 2 vCPU，实测瓶颈是 CPU 而不是
 * 数据库（`/api/orders` 872 ms 里数据库只占 121 ms，其余是 Node 序列化）。
 *
 * 所以这里缓存的是**序列化之后的 JSON 字符串**，不是对象 ——
 * 命中时连 `JSON.stringify` 都省掉，直接把字符串塞进 Response。
 *
 * 为什么是进程内 Map 而不是 Redis：单容器部署，加一个外部依赖既违背
 * 「迁到客户服务器还在吗」的部署铁律，也解决不了任何这里没解决的问题。
 * 容器重启缓存丢失是可接受的 —— 大不了重算一次。
 */

/** 单条最大缓存体积。超过就不缓存 —— 缓存不该成为新的内存问题（刚修完 OOM）。 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
/** 最多存多少条，超出按最久未使用淘汰。上限 ≈ 100 × 2 MB = 200 MB 最坏情况， */
/** 但实测分析响应普遍在 5–180 KB，真实占用远低于此。 */
const MAX_ENTRIES = 100

/** 查询区间**包含今天**时用的 TTL：老板盯着今日销售额，不能几分钟不动。 */
const TTL_LIVE_MS = 60_000
/** 纯历史区间的 TTL：这些数字不会再变，只是防止缓存无限期占内存。 */
const TTL_HISTORICAL_MS = 15 * 60_000

interface Entry {
  body: string
  expiresAt: number
  /** 用于 LRU：每次命中刷新 */
  lastUsed: number
}

const store = new Map<string, Entry>()

/** 命中/未命中计数，仅用于排查（通过 getStats 读） */
let hits = 0
let misses = 0

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return
  // 先清过期的
  const now = Date.now()
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k)
  }
  // 还超就按最久未使用淘汰
  while (store.size > MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, v] of store) {
      if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k }
    }
    if (oldestKey === null) break
    store.delete(oldestKey)
  }
}

/**
 * 按查询区间选 TTL。`end` 是独占上界，> 现在说明区间覆盖到今天（甚至未来），
 * 那部分数据还在变。
 */
export function ttlFor(end: Date): number {
  return end.getTime() > Date.now() ? TTL_LIVE_MS : TTL_HISTORICAL_MS
}

/**
 * 构造缓存 key。
 *
 * ⛔ **roles 必须进 key**。目前 `/api/analytics/*` 全都不做行级过滤
 * （`withAuth(req, async () => …)` 连 user 参数都没接），所以理论上不带 roles 也不会串。
 * 但哪天有人给某个分析接口加了「SALES 只看自己客户」这类过滤，
 * 而忘了同步改这里，缓存就会把 A 业务员的数字发给 B —— 那是数据泄露，不是性能问题。
 * 带上 roles 的代价只是同一份数据按角色多存几份，换的是这类错误不可能发生。
 */
export function cacheKey(pathname: string, searchParams: URLSearchParams, roles: string[]): string {
  const sorted = [...searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const qs = sorted.map(([k, v]) => `${k}=${v}`).join('&')
  return `${pathname}?${qs}|r=${[...roles].sort().join(',')}`
}

/** 取缓存。未命中或已过期返回 null。 */
export function getCached(key: string): string | null {
  const hit = store.get(key)
  if (!hit) { misses++; return null }
  if (hit.expiresAt <= Date.now()) { store.delete(key); misses++; return null }
  hit.lastUsed = Date.now()
  hits++
  return hit.body
}

/** 存缓存。过大的响应直接跳过，不做截断（截断的缓存比没有缓存更危险）。 */
export function setCached(key: string, body: string, ttlMs: number): void {
  if (body.length > MAX_ENTRY_BYTES) return
  store.set(key, { body, expiresAt: Date.now() + ttlMs, lastUsed: Date.now() })
  evictIfNeeded()
}

/** 清空（写操作之后或测试用） */
export function clearAnalyticsCache(): void {
  store.clear()
}

export function getStats(): { size: number; hits: number; misses: number } {
  return { size: store.size, hits, misses }
}

/** 仅测试用：重置计数 */
export function __resetStats(): void {
  hits = 0
  misses = 0
}

/**
 * `withAuth` 的带缓存版本。**签名与 withAuth 完全一致**，所以接入一个分析路由
 * 只需要把 `withAuth(` 改成 `withCachedAuth(`，其余一个字都不用动：
 *
 * ```ts
 * export async function GET(req: Request) {
 *   return withCachedAuth(req, async () => {
 *     …原样不动…
 *   }, ['BOSS', 'FINANCE'])          // ← allowedRoles 照样传
 * }
 * ```
 *
 * 刻意做成这个形状，是因为第一版试着用正则把路由改写成
 * `withAuth(req, (user) => withAnalyticsCache(...))`，结果把 `withAuth` 的第三个
 * 参数 `allowedRoles` 一起吃进了内层调用 —— 16 个文件全错。
 * 能靠「只改函数名」完成的事，就不要去改调用结构。
 *
 * 只缓存 200 的响应：400/403/500 缓存了只会让错误更难复现。
 * TTL 由查询区间自己决定（覆盖到今天就短），调用方不用关心。
 */
export async function withCachedAuth(
  req: Request,
  handler: (user: { role?: string | null; roles?: string[] | null }) => Promise<Response>,
  allowedRoles?: string[],
): Promise<Response> {
  // 动态引入避免 lib/auth ↔ lib/analytics/cache 循环依赖
  const { withAuth, effectiveRoles } = await import('@/lib/auth')

  return withAuth(req, async (user) => {
    const url = new URL(req.url)
    const key = cacheKey(url.pathname, url.searchParams, effectiveRoles(user))

    const cachedBody = getCached(key)
    if (cachedBody !== null) {
      // 直接把缓存好的字符串交出去 —— 连 JSON.stringify 都不跑，
      // 而序列化正是这台 2 vCPU 机器上的实际瓶颈。
      return new Response(cachedBody, {
        headers: { 'content-type': 'application/json', 'x-cache': 'HIT' },
      })
    }

    const res = await handler(user)
    if (res.status !== 200) return res

    // Response 的 body 只能读一次，所以要用读出来的字符串重新构造一个返回。
    const body = await res.text()
    const { resolveDateRange } = await import('@/lib/analytics/metrics')
    const { end } = resolveDateRange(url.searchParams.get('from'), url.searchParams.get('to'))
    setCached(key, body, ttlFor(end))

    const headers = new Headers(res.headers)
    headers.set('x-cache', 'MISS')
    return new Response(body, { status: 200, headers })
  }, allowedRoles)
}
