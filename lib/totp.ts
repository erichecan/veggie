/**
 * TOTP (RFC 6238) 纯 TS 实现，基于 Web Crypto API
 * ============================================================================
 * 为什么不用 `otplib` 之类的库？因为本项目 npm registry 在沙箱里被墙；
 * 自己实现一份 20 行代码的 HMAC-SHA1 + Base32，无依赖。
 *
 * 兼容 Google Authenticator / Authy / 1Password / 任何 RFC 6238 客户端。
 */

// ─── Base32 编解码 ───────────────────────────────────────────────────────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    const idx = B32_ALPHABET.indexOf(c)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

// ─── 生成 20 字节随机秘钥（推荐 RFC 长度） ──────────────────────────────
export function generateSecret(): string {
  const raw = new Uint8Array(20)
  crypto.getRandomValues(raw)
  return base32Encode(raw)
}

// ─── HMAC-SHA1 → TOTP 6 位 ───────────────────────────────────────────────
async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  // Web Crypto 的 BufferSource 类型要求 buffer 是 ArrayBuffer（非 SharedArrayBuffer）。
  // 用 .slice() 保证拿到纯 ArrayBuffer 而不是 ArrayBufferLike。
  const keyBuf: ArrayBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer
  const msgBuf: ArrayBuffer = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer
  const ck = await crypto.subtle.importKey(
    'raw', keyBuf, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', ck, msgBuf)
  return new Uint8Array(sig)
}

/** RFC 6238 TOTP 生成 */
export async function generateTotp(
  secretBase32: string,
  timestamp: number = Date.now(),
  period = 30,
  digits = 6,
): Promise<string> {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(timestamp / 1000 / period)
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(counter))
  const hmac = await hmacSha1(key, buf)
  const offset = hmac[hmac.length - 1] & 0xf
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
     (hmac[offset + 3] & 0xff)
  ) % 10 ** digits
  return String(code).padStart(digits, '0')
}

/** 校验用户输入。允许 ±1 个窗口（RFC 6238 推荐宽容度） */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  period = 30,
): Promise<boolean> {
  const now = Date.now()
  for (const offset of [-period, 0, period]) {
    const expected = await generateTotp(secretBase32, now + offset * 1000, period, 6)
    if (expected === code) return true
  }
  return false
}

/** 生成 otpauth:// URL 供二维码扫描 */
export function otpauthUrl(accountName: string, issuer: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
