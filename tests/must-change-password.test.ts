import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assessNewPassword, PASSWORD_MIN_LENGTH } from '../lib/password-policy'
import { PAGE_ROUTE_RULES, API_ROUTE_RULES, requiredPermissionsFor } from '../lib/rbac/route-map'

/**
 * 首次登录强制改密（S2）。
 *
 * 这条链路有五段，任何一段断了都是「看起来强制了，其实没有」：
 *   1. 库里有 mustChangePassword 标记
 *   2. 登录把标记写进 token 的 mcp
 *   3. withAuth 据此挡住除改密外的一切
 *   4. 改密接口自己把关（验旧密码、强度、不能原样不动）
 *   5. 改完清标记、作废旧 token
 */

const authSrc = readFileSync('lib/auth.ts', 'utf-8')
const loginSrc = readFileSync('app/api/auth/login/route.ts', 'utf-8')
const changeSrc = readFileSync('app/api/auth/change-password/route.ts', 'utf-8')
const schema = readFileSync('prisma/schema.prisma', 'utf-8')

// ── 密码强度：挡住这次事故里真实出现过的那几个 ────────────────────────────

test('这次实际查出来的弱口令必须被拒', () => {
  // 生产上真实存在过的三个：test123（42 个账号）、Demo1234!（9 个）、123456（1 个）
  for (const pw of ['test123', 'Demo1234!', '123456']) {
    const v = assessNewPassword(pw)
    assert.equal(v.ok, false, `${pw} 竟然通过了强度校验`)
  }
})

test('在弱口令后面补长度也不行', () => {
  assert.equal(assessNewPassword('test123test123').ok, false, 'test123 重复两遍就过了')
  assert.equal(assessNewPassword('password12345').ok, false)
})

test('太短、连续、重复的都拒', () => {
  assert.equal(assessNewPassword('Ab3!x').ok, false, '长度不够却通过了')
  assert.equal(assessNewPassword('aaaaaaaaaaaa').ok, false)
  assert.equal(assessNewPassword('abcdefghijkl').ok, false)
  assert.equal(assessNewPassword('123456789012').ok, false)
})

test('不能包含自己的邮箱名或姓名', () => {
  assert.equal(
    assessNewPassword('moazzam-2026x', { email: 'driver.moazzam@veggie.local' }).ok,
    false,
    '密码里含邮箱名却通过了',
  )
  assert.equal(assessNewPassword('zhangmin-88x!', { name: 'Zhang Min' }).ok, false)
})

test('正常的强密码要放行 —— 规则不能严到没人能设出密码', () => {
  for (const pw of ['Kestrel-Harbour-42', 'ni3hao3ma5-tomato', 'Qz7#mbleafRiver']) {
    const v = assessNewPassword(pw, { email: 'someone@x.com', name: 'Some One' })
    assert.equal(v.ok, true, `${pw} 被拒了，理由：${v.reason}`)
  }
})

test('首尾空格要拒 —— 换个输入法就打不出来了', () => {
  assert.equal(assessNewPassword(' Kestrel-Harbour-42 ').ok, false)
})

test('最短长度对外暴露，前端提示才不会和后端对不上', () => {
  assert.ok(PASSWORD_MIN_LENGTH >= 10)
  const page = readFileSync('app/[locale]/change-password/page.tsx', 'utf-8')
  assert.ok(/PASSWORD_MIN_LENGTH/.test(page), '改密页把长度硬编码了，改后端就会不一致')
})

// ── 链路各段 ──────────────────────────────────────────────────────────────

test('第 1 段：schema 有 mustChangePassword', () => {
  assert.ok(/mustChangePassword\s+Boolean\s+@default\(false\)/.test(schema))
})

test('第 2 段：登录把标记写进 token', () => {
  assert.ok(/mcp:\s*user\.mustChangePassword/.test(loginSrc), 'token 里没带 mcp')
  assert.ok(/mustChangePassword:\s*user\.mustChangePassword/.test(loginSrc), '响应里没带给前端')
})

test('第 3 段：withAuth 挡住除改密外的一切', () => {
  assert.ok(/PASSWORD_CHANGE_REQUIRED/.test(authSrc), 'withAuth 没有这道闸')
  assert.ok(/user\.mcp === true/.test(authSrc), '判定条件不对')
  assert.ok(/isPasswordChangeExempt/.test(authSrc), '没有豁免名单，改密接口自己也会被挡死')
})

test('豁免名单只放行改密相关的接口', () => {
  const block = authSrc.slice(
    authSrc.indexOf('const PASSWORD_CHANGE_EXEMPT'),
    authSrc.indexOf('function isPasswordChangeExempt'),
  )
  const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(listed.includes('/api/auth/change-password'), '连改密接口都没放行')
  for (const p of listed) {
    assert.ok(
      p.startsWith('/api/auth/'),
      `豁免名单里混进了业务接口 ${p} —— 强制改密就成了一句建议`,
    )
  }
})

test('第 4 段：改密接口自己把关', () => {
  assert.ok(/bcrypt\.compare\(currentPassword/.test(changeSrc), '没验旧密码')
  assert.ok(/assessNewPassword\(/.test(changeSrc), '没做强度校验')
  assert.ok(/新密码不能与当前密码相同/.test(changeSrc), '允许把密码改成原样')
  assert.ok(/rateLimit\(/.test(changeSrc), '验旧密码也是爆破面，没限流')
})

test('第 5 段：改完清标记并作废旧 token', () => {
  assert.ok(/mustChangePassword:\s*false/.test(changeSrc), '改完没清标记，会一直被要求改密')
  assert.ok(
    /permVersion:\s*\{\s*increment:\s*1\s*\}/.test(changeSrc),
    '改密后没作废旧 token —— 改密的常见动机就是怀疑被人登了，不作废等于白改',
  )
})

// ── 路由可达性：改密页进不去的话，整件事就死锁了 ──────────────────────────

test('改密页有页面规则 —— 否则「让人去改密码，却把门锁上」', () => {
  // 新体系兜底语义是「未命中规则即拒绝」，漏登记就是 403
  const required = requiredPermissionsFor(PAGE_ROUTE_RULES, '/change-password', 'GET')
  assert.notEqual(required, undefined, '/change-password 没有页面规则，被强制改密的人进不去')
  assert.equal(required, null, '改密页不该要求任何权限点')
})

test('改密接口任何登录用户都能调', () => {
  const required = requiredPermissionsFor(API_ROUTE_RULES, '/api/auth/change-password', 'POST')
  assert.equal(required, null, '改密接口要求了权限点，弱口令账号可能正好没有')
})

test('前端认 PASSWORD_CHANGE_REQUIRED 并把人送去改密页', () => {
  const apiSrc = readFileSync('lib/api.ts', 'utf-8')
  assert.ok(/PASSWORD_CHANGE_REQUIRED/.test(apiSrc))
  assert.ok(/change-password\?forced=1/.test(apiSrc), '没跳转，用户会在报错界面里打转')
})
