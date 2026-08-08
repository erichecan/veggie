import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  checkLocked, recordFailure, recordSuccess, resetLoginThrottle, LOGIN_THROTTLE_CONFIG as C,
} from '../lib/login-throttle'

/**
 * 按账号的登录失败锁定（S1）。
 *
 * 这一层存在的唯一理由是：按 IP 的限流换个 IP 就重新开始。所以这里的每条断言
 * 都不带 IP —— 它本来就不该知道请求从哪来。
 */

beforeEach(() => resetLoginThrottle())

const T0 = 1_700_000_000_000   // 固定时间，不用 Date.now()，免得测试跟着时钟飘

test('连续失败到阈值才锁，之前不锁', () => {
  for (let i = 1; i < C.FAIL_THRESHOLD; i++) {
    const s = recordFailure('a@x.com', T0)
    assert.equal(s.locked, false, `第 ${i} 次失败就锁了，太早`)
  }
  const s = recordFailure('a@x.com', T0)
  assert.equal(s.locked, true, `失败 ${C.FAIL_THRESHOLD} 次仍未锁定`)
  assert.ok(s.retryAfterSec > 0)
})

test('锁定只影响这个账号，别人照常登录', () => {
  for (let i = 0; i < C.FAIL_THRESHOLD; i++) recordFailure('victim@x.com', T0)
  assert.equal(checkLocked('victim@x.com', T0).locked, true)
  // 客户是一个办公室、共用一个出口 IP。按 IP 锁会误伤同事，所以这条很重要
  assert.equal(checkLocked('colleague@x.com', T0).locked, false)
})

test('邮箱大小写与空白不影响判定', () => {
  for (let i = 0; i < C.FAIL_THRESHOLD; i++) recordFailure('Foo@X.com', T0)
  assert.equal(checkLocked('  foo@x.com ', T0).locked, true, '换个大小写就绕过了')
})

test('锁定到期自动解除', () => {
  for (let i = 0; i < C.FAIL_THRESHOLD; i++) recordFailure('b@x.com', T0)
  assert.equal(checkLocked('b@x.com', T0 + C.BASE_LOCK_MS - 1).locked, true)
  assert.equal(checkLocked('b@x.com', T0 + C.BASE_LOCK_MS + 1).locked, false)
})

test('反复触发锁定，时长递增但有上限', () => {
  const lockFor = (round: number) => {
    let at = T0 + round * C.MAX_LOCK_MS * 2   // 每轮都从解锁后开始
    for (let i = 0; i < C.FAIL_THRESHOLD; i++) recordFailure('c@x.com', at)
    return checkLocked('c@x.com', at).retryAfterSec
  }
  const first = lockFor(0)
  const second = lockFor(1)
  assert.ok(second > first, '第二次锁定没有比第一次更久')
  let last = second
  for (let r = 2; r < 40; r++) last = lockFor(r)
  assert.ok(last <= C.MAX_LOCK_MS / 1000, `锁定时长突破了上限：${last}s`)
})

test('失败之间隔太久要重新计数，不能把昨天的失败攒起来', () => {
  for (let i = 0; i < C.FAIL_THRESHOLD - 1; i++) recordFailure('d@x.com', T0)
  // 隔了一个窗口之后再失败一次，不应该凑成锁定
  const s = recordFailure('d@x.com', T0 + C.FAIL_WINDOW_MS + 1)
  assert.equal(s.locked, false, '陈旧的失败计数没有过期')
})

test('登录成功清零，正常用户偶尔打错不会越锁越久', () => {
  for (let i = 0; i < C.FAIL_THRESHOLD - 1; i++) recordFailure('e@x.com', T0)
  recordSuccess('e@x.com')
  for (let i = 1; i < C.FAIL_THRESHOLD; i++) {
    assert.equal(recordFailure('e@x.com', T0).locked, false, '成功之后计数没清零')
  }
})

// ── 接入点：逻辑对了但没接上去，等于没有 ──────────────────────────────────

const loginSrc = readFileSync('app/api/auth/login/route.ts', 'utf-8')

test('登录接口真的接了这一层', () => {
  assert.ok(/checkLocked\(/.test(loginSrc), '登录前没有查锁定状态')
  assert.ok(/recordFailure\(/.test(loginSrc), '失败时没有计数')
  assert.ok(/recordSuccess\(/.test(loginSrc), '成功后没有清零')
  assert.ok(/rateLimit\(/.test(loginSrc), '按 IP 的那道被删掉了 —— 两道是互补的，不是替代')
})

test('账号不存在与密码错误走同一条返回路径', () => {
  // 分开处理会让「这个邮箱存在吗」从行为差异里漏出去
  assert.ok(
    /if \(!user \|\| !valid\)/.test(loginSrc),
    '账号不存在与密码错误没有合并处理，存在用户名枚举风险',
  )
})

test('锁定期内即使密码正确也拒绝', () => {
  // checkLocked 必须在查库/比对密码之前返回，否则「响应变了」会告诉攻击者蒙对了
  const lockIdx = loginSrc.indexOf('checkLocked(')
  const compareIdx = loginSrc.indexOf('bcrypt.compare(')
  assert.ok(lockIdx > 0 && compareIdx > 0)
  assert.ok(lockIdx < compareIdx, '锁定判定排在密码比对之后，锁定就成了一个预言机')
})

test('动态码错误也计入失败', () => {
  const mfaBlock = loginSrc.slice(loginSrc.indexOf('verifyTotp('), loginSrc.indexOf('recordSuccess('))
  assert.ok(
    /recordFailure\(/.test(mfaBlock),
    '密码这关过了之后，6 位动态码可以无限试',
  )
})
