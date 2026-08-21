/**
 * 非分析类只读接口的进程内响应缓存。
 * ============================================================================
 * 目标是准静态、无用户维度的辅助接口（商品分类、司机配置、筛选下拉选项这类）——
 * 复用 lib/analytics/cache.ts 里已有的 Map 存储 / LRU 淘汰 / 体积上限，
 * 不另起一份缓存基础设施，也不占用独立的内存预算。
 *
 * 与 withCachedAuth 的区别：这里的目标路由**大多没有 withAuth 包装**（公开只读），
 * 所以不能套 withAuth 的签名；TTL 也不是按查询区间推导（这些数据没有"今天"的概念），
 * 而是调用方直接给一个固定值 —— 短到能接受写操作之后的短暂陈旧即可，
 * 这些表写得很少，容忍几十秒陈旧换掉每次请求都全表查询是划算的。
 */
import { cacheKey, getCached, setCached } from '@/lib/analytics/cache'

/** 準静态辅助接口的默认 TTL：写操作很少，几十秒陈旧可接受。 */
export const TTL_STATIC_MS = 30_000

/**
 * 缓存一个无鉴权（或鉴权与结果无关）GET 接口的响应。
 * 只缓存 200：出错的响应缓存了只会让排查更难。
 */
export async function withCachedGet(
  req: Request,
  handler: () => Promise<Response>,
  ttlMs: number = TTL_STATIC_MS,
): Promise<Response> {
  const url = new URL(req.url)
  const key = cacheKey(url.pathname, url.searchParams, [])

  const cachedBody = getCached(key)
  if (cachedBody !== null) {
    return new Response(cachedBody, {
      headers: { 'content-type': 'application/json', 'x-cache': 'HIT' },
    })
  }

  const res = await handler()
  if (res.status !== 200) return res

  const body = await res.text()
  setCached(key, body, ttlMs)

  const headers = new Headers(res.headers)
  headers.set('x-cache', 'MISS')
  return new Response(body, { status: 200, headers })
}
