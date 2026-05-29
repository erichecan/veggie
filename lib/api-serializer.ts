/**
 * API 响应序列化器
 * ============================================================================
 * 统一在 API 边界把 Prisma `Decimal.js` 实例转成 `number`，并隐藏敏感字段。
 *
 * 为什么需要：
 *   JSON.stringify(DecimalObj) 默认会调用 DecimalObj.toJSON() → 返回字符串（如 "10.00"），
 *   前端如果 `(price).toFixed(2)` 会抛 TypeError，或算术 `a + b` 变成字符串拼接。
 *
 * 用法：
 *   import { serializeApi } from '@/lib/api-serializer'
 *   return NextResponse.json(serializeApi(prismaResult))
 *
 * 对于已经知道结构的 API，可以用 `toNum()` 做字段级显式转换；
 * 对于大型/嵌套对象，用 `serializeApi()` 递归处理。
 */

const SENSITIVE_KEYS = new Set([
  'passwordHash', 'mfaSecret',   // 永不返回给前端
])

function isDecimal(v: unknown): v is { toNumber(): number } {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { toNumber?: unknown }).toNumber === 'function'
  )
}

/**
 * 递归序列化任意 API 响应对象：
 *   - Prisma.Decimal → number
 *   - Date           → ISO string（Next.js 默认也这样，但显式处理避免 Date 被当对象）
 *   - passwordHash / mfaSecret → 删除
 *   - 数组和嵌套对象递归处理
 */
export function serializeApi<T>(value: T): T {
  return walk(value) as T
}

function walk(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v
  if (isDecimal(v)) return v.toNumber()
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(walk)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE_KEYS.has(k)) continue
      out[k] = walk(val)
    }
    return out
  }
  // function / symbol / undefined – drop
  return undefined
}
