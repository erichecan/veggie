/**
 * TOTP (RFC 6238) 单元测试
 * ============================================================================
 * 对照 RFC 6238 Appendix B 的测试向量验证实现。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { base32Encode, base32Decode, generateTotp, verifyTotp, generateSecret, otpauthUrl } from '../lib/totp'

describe('Base32', () => {
  test('encode/decode 往返', () => {
    const raw = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const encoded = base32Encode(raw)
    assert.equal(encoded, 'JBSWY3DP')
    const decoded = base32Decode(encoded)
    assert.deepEqual(Array.from(decoded), Array.from(raw))
  })

  test('空数组', () => {
    assert.equal(base32Encode(new Uint8Array(0)), '')
    assert.equal(base32Decode('').length, 0)
  })
})

describe('TOTP', () => {
  test('随机生成的 secret 长度 ≥ 32 字符（20 字节 → 32 base32）', () => {
    const s = generateSecret()
    assert.ok(s.length === 32, `expected 32 chars, got ${s.length}`)
  })

  test('同一 timestamp 生成同一 code', async () => {
    const secret = generateSecret()
    const t = 1_000_000_000_000
    const a = await generateTotp(secret, t)
    const b = await generateTotp(secret, t)
    assert.equal(a, b)
    assert.match(a, /^\d{6}$/)
  })

  test('不同时间窗口 code 不同', async () => {
    const secret = generateSecret()
    const a = await generateTotp(secret, 1_000_000_000_000)       // t=1e9 s
    const b = await generateTotp(secret, 1_000_000_000_000 + 60_000) // +60s 跨 2 个窗口
    assert.notEqual(a, b)
  })

  test('verify 当前窗口通过', async () => {
    const secret = generateSecret()
    const code = await generateTotp(secret)
    const ok = await verifyTotp(secret, code)
    assert.equal(ok, true)
  })

  test('verify 错误 code 拒绝', async () => {
    const secret = generateSecret()
    const ok = await verifyTotp(secret, '000000')
    assert.equal(ok, false)
  })

  test('otpauth URL 包含 secret/issuer/algorithm', () => {
    const url = otpauthUrl('alice@test.com', 'Veggie Demo', 'ABCDEFGHIJKLMNOP')
    assert.ok(url.startsWith('otpauth://totp/'))
    assert.ok(url.includes('secret=ABCDEFGHIJKLMNOP'))
    assert.ok(url.includes('issuer=Veggie+Demo') || url.includes('issuer=Veggie%20Demo'))
    assert.ok(url.includes('algorithm=SHA1'))
    assert.ok(url.includes('digits=6'))
    assert.ok(url.includes('period=30'))
  })
})

describe('RFC 6238 官方测试向量', () => {
  // RFC 6238 Appendix B 的 SHA-1 测试向量（20 字节 "12345678901234567890" = base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ）
  const TEST_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  const vectors: Array<{ t: number; expected: string }> = [
    { t: 59,          expected: '94287082' },   // 8-digit
    { t: 1111111109,  expected: '07081804' },
    { t: 1111111111,  expected: '14050471' },
    { t: 1234567890,  expected: '89005924' },
    { t: 2000000000,  expected: '69279037' },
  ]

  for (const v of vectors) {
    test(`t=${v.t} → 6-digit matches last 6 of ${v.expected}`, async () => {
      const got = await generateTotp(TEST_SECRET, v.t * 1000, 30, 6)
      // RFC 向量是 8 位，我们生成 6 位 → 比较末尾 6 位
      assert.equal(got, v.expected.slice(-6))
    })
  }
})
