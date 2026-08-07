/**
 * 权限位图编解码
 * ============================================================================
 * 为什么要位图：`middleware.ts` 跑在 Edge runtime，用不了 Prisma，所以判权限时
 * 没法查库。而 8/6 审计的结论是 middleware 边界砍掉了一半可达格，这一层不能丢。
 * 于是权限集必须随 token 走，又不能撑爆 cookie —— 181 个权限点编成位图只要
 * 23 字节，base64url 之后约 31 个字符。
 *
 * 位序就是 catalog 的 sortKey，由 lib/rbac/sortkeys.json 冻结。
 * ⛔ 序号漂移会让已签发的 token 静默错位（用户凭空拿到别人的权限，且不报错），
 *    所以那份快照不能手改，只能由 scripts/rbac/sync-sortkeys.ts 维护。
 */
import { PERMISSION_BITMAP_BYTES, SORT_KEY_BY_ID, PERMISSIONS } from './catalog'

/** 权限点 id 集合 → base64url 位图 */
export function encodePermissions(ids: Iterable<string>): string {
  const bytes = new Uint8Array(PERMISSION_BITMAP_BYTES)
  for (const id of ids) {
    const key = SORT_KEY_BY_ID.get(id)
    if (key === undefined) continue // catalog 里没有的 id 直接忽略，不占位
    bytes[key >> 3] |= 1 << (key & 7)
  }
  return toBase64Url(bytes)
}

/** base64url 位图 → 判定器。解一次，之后每次判定是 O(1) 的位运算 */
export function decodePermissions(bitmap: string | undefined | null): PermissionSet {
  const bytes = bitmap ? fromBase64Url(bitmap) : new Uint8Array(0)
  return new PermissionSet(bytes)
}

export class PermissionSet {
  constructor(private readonly bytes: Uint8Array) {}

  has(id: string): boolean {
    const key = SORT_KEY_BY_ID.get(id)
    if (key === undefined) return false
    const byte = this.bytes[key >> 3]
    if (byte === undefined) return false
    return (byte & (1 << (key & 7))) !== 0
  }

  /** 任一命中即可 */
  hasAny(ids: Iterable<string>): boolean {
    for (const id of ids) if (this.has(id)) return true
    return false
  }

  /** 展开成 id 列表。只在调试与配置页用，判定路径别调它 */
  toArray(): string[] {
    return PERMISSIONS.filter((p) => this.has(p.id)).map((p) => p.id)
  }

  get size(): number {
    let n = 0
    for (const b of this.bytes) {
      let v = b
      while (v) { n += v & 1; v >>= 1 }
    }
    return n
  }
}

// ── base64url ⇄ 字节 ───────────────────────────────────────────────────────
// 手写而不用 Buffer：middleware 的 Edge runtime 里没有 Node 的 Buffer。
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64[b2 & 63]
  }
  return out
}

function fromBase64Url(s: string): Uint8Array {
  const out = new Uint8Array((s.length * 3) >> 2)
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of s) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}
