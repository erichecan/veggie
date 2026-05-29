/**
 * 轻量速率限制（token bucket, 进程内存）
 * ============================================================================
 * 适用于单节点 Cloud Run 场景。如果水平扩展到多实例，每个实例独立计数，
 * 总体速率会 = 节点数 × 限额。真生产环境建议换 Upstash Redis 计数。
 *
 * 用法：
 *   import { rateLimit } from '@/lib/rate-limit'
 *   const denied = rateLimit(req, { id: 'login', max: 10, windowMs: 60_000 })
 *   if (denied) return denied
 */
import { NextResponse } from 'next/server'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitOptions {
  /** 唯一 ID，用于区分不同端点的限流（如 'login' / 'order' / 'upload'） */
  id: string
  /** 时间窗口内最大请求数 */
  max: number
  /** 时间窗口（毫秒），默认 60 秒 */
  windowMs?: number
  /** 自定义 key（不填时用 IP）。例如按 userId 限流 */
  keyFn?: (req: Request) => string
}

function clientIp(req: Request): string {
  // Cloud Run / Vercel 使用这些 header
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const real = req.headers.get('x-real-ip')
  if (real) return real
  return 'unknown'
}

/**
 * 速率限制检查。超限返回 NextResponse(429)，未超限返回 null。
 */
export function rateLimit(req: Request, opts: RateLimitOptions): NextResponse | null {
  const windowMs = opts.windowMs ?? 60_000
  const key = `${opts.id}:${opts.keyFn ? opts.keyFn(req) : clientIp(req)}`
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return null
  }

  bucket.count += 1
  if (bucket.count > opts.max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
    return NextResponse.json(
      { error: 'RATE_LIMIT', message: `请求过于频繁，请 ${retryAfter}s 后重试` },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(opts.max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(bucket.resetAt / 1000)),
        },
      },
    )
  }

  return null
}

/** 定期清理过期 bucket（避免内存泄漏） */
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k)
  }
}, 300_000).unref?.()
