/**
 * 电子签收的服务端完整性规则。
 * 签名是收货凭证，两条不能让客户端说了算：时间戳由服务端打、签过就不许改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileSignatures,
  decodedPngBytes,
  describeIssues,
  MAX_SIGNATURE_BYTES,
} from '../lib/trip-signature'

const NOW = new Date('2026-08-02T12:00:00.000Z')
/** 一个体积很小的合法 PNG data URI */
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function rest(over: Record<string, unknown> = {}) {
  return { restaurantId: 'r1', restaurantName: '张记餐厅', delivered: false, ...over }
}

test('decodedPngBytes: 认得合法 PNG data URI，认不出别的', () => {
  assert.ok((decodedPngBytes(SIG) ?? 0) > 0)
  assert.equal(decodedPngBytes('data:image/jpeg;base64,abcd'), null)
  assert.equal(decodedPngBytes('not a data uri'), null)
  assert.equal(decodedPngBytes('<script>alert(1)</script>'), null)
})

test('新签名：signedAt 一律用服务端时间，客户端传的被丢弃', () => {
  const { restaurants, issues } = reconcileSignatures(
    [rest()],
    [rest({ signature: SIG, signerName: '李四', signedAt: '1999-01-01T00:00:00.000Z' })],
    NOW,
  )
  assert.deepEqual(issues, [])
  assert.equal(restaurants[0].signedAt, NOW.toISOString(), '必须是服务端时间，不能是客户端的 1999')
  assert.equal(restaurants[0].signerName, '李四')
})

test('已签收的签名不可更改——整包 PUT 想换掉会被拦', () => {
  const before = [rest({ signature: SIG, signerName: '李四', signedAt: NOW.toISOString(), delivered: true })]
  const tampered = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
  const { restaurants, issues } = reconcileSignatures(before, [rest({ signature: tampered, signerName: '王五' })], NOW)

  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'immutable')
  assert.equal(restaurants[0].signature, SIG, '库里的签名必须原样保留')
  assert.equal(restaurants[0].signerName, '李四', '签收人也不能被改')
})

test('已签收的签名不可被抹掉', () => {
  const before = [rest({ signature: SIG, signerName: '李四', signedAt: NOW.toISOString() })]
  const { restaurants, issues } = reconcileSignatures(before, [rest({ signature: null })], NOW)
  assert.equal(issues[0]?.kind, 'immutable')
  assert.equal(restaurants[0].signature, SIG)
})

test('同一次 PUT 里其他字段照常更新，不受签名不可变影响', () => {
  const before = [rest({ signature: SIG, signerName: '李四', signedAt: NOW.toISOString(), payment: 0 })]
  const { restaurants } = reconcileSignatures(
    before,
    [rest({ signature: SIG, signerName: '李四', payment: 128.5, delivered: true })],
    NOW,
  )
  assert.equal((restaurants[0] as Record<string, unknown>).payment, 128.5)
  assert.equal((restaurants[0] as Record<string, unknown>).delivered, true)
})

test('签名格式不对：拒绝并清空，不写进库', () => {
  const { restaurants, issues } = reconcileSignatures(
    [rest()],
    [rest({ signature: 'data:text/html;base64,PHNjcmlwdD4=', signerName: '李四' })],
    NOW,
  )
  assert.equal(issues[0]?.kind, 'invalid_format')
  assert.equal(restaurants[0].signature, null)
})

test('签名过大：拒绝——JSON 列塞不下几 MB 的图', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_SIGNATURE_BYTES * 2)
  const { restaurants, issues } = reconcileSignatures([rest()], [rest({ signature: huge, signerName: '李四' })], NOW)
  assert.equal(issues[0]?.kind, 'too_large')
  assert.equal(restaurants[0].signature, null)
})

test('有签名但没签收人姓名：拒绝——签名图认不出是谁签的', () => {
  const { restaurants, issues } = reconcileSignatures([rest()], [rest({ signature: SIG, signerName: '  ' })], NOW)
  assert.equal(issues[0]?.kind, 'missing_signer')
  assert.equal(restaurants[0].signature, null)
})

test('没带签名的站点：客户端伪造的 signedAt 会被清掉', () => {
  const { restaurants, issues } = reconcileSignatures(
    [rest()],
    [rest({ signedAt: '2020-01-01T00:00:00.000Z' })],
    NOW,
  )
  assert.deepEqual(issues, [])
  assert.equal(restaurants[0].signedAt, null)
})

test('签收人姓名截断到 40 字，且去空白', () => {
  const { restaurants } = reconcileSignatures(
    [rest()],
    [rest({ signature: SIG, signerName: '  ' + '名'.repeat(60) + '  ' })],
    NOW,
  )
  assert.equal((restaurants[0].signerName ?? '').length, 40)
})

test('多站点：一个签了一个没签，互不干扰', () => {
  const before = [rest({ restaurantId: 'r1' }), rest({ restaurantId: 'r2' })]
  const { restaurants, issues } = reconcileSignatures(
    before,
    [
      rest({ restaurantId: 'r1', signature: SIG, signerName: '李四' }),
      rest({ restaurantId: 'r2' }),
    ],
    NOW,
  )
  assert.deepEqual(issues, [])
  assert.equal(restaurants[0].signedAt, NOW.toISOString())
  assert.equal(restaurants[1].signature ?? null, null)
})

test('describeIssues 给出人能看懂的话', () => {
  const msg = describeIssues([{ kind: 'immutable', restaurantId: 'r1', restaurantName: '张记餐厅' }])
  assert.match(msg, /张记餐厅/)
  assert.match(msg, /已完成签收/)
})
