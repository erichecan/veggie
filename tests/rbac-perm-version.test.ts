import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 「权限变更后强制重新登录」这条链路（T12）。
 *
 * 链路有四段，任何一段断了都不会报错，只会表现为「改了权限但对方照样能用」：
 *   1. 改权限的接口 bump `User.permVersion`
 *   2. 签发 token 时把当时的 permVersion 写进 `pv`
 *   3. `withAuth` 比较两者，不一致返回 401 + PERMISSION_CHANGED
 *   4. 前端认这个 code，跳登录页并说清原因
 *
 * 这里用静态检查覆盖，因为 1 和 3 都要真库才能端到端跑。
 */

const authSrc = readFileSync('lib/auth.ts', 'utf-8')
const permVersionSrc = readFileSync('lib/rbac/perm-version.ts', 'utf-8')
const adminSrc = readFileSync('lib/rbac/admin.ts', 'utf-8')
const loginSrc = readFileSync('app/api/auth/login/route.ts', 'utf-8')
const apiSrc = readFileSync('lib/api.ts', 'utf-8')
const enterSrc = readFileSync('app/[locale]/enter/page.tsx', 'utf-8')

test('第 1 段：改权限的接口会 bump permVersion', () => {
  assert.ok(
    /permVersion:\s*\{\s*increment:\s*1\s*\}/.test(adminSrc),
    'invalidateTokens 没有真的 bump permVersion',
  )
  assert.ok(
    /forgetPermVersions/.test(adminSrc),
    '改完没清本进程缓存 —— 管理员改完立刻去验证会看到「怎么还没踢」',
  )
})

test('第 2 段：登录时把当前 permVersion 写进 token 的 pv', () => {
  assert.ok(/pv:\s*perms\.permVersion/.test(loginSrc), 'token 里没带 pv，第 3 段就无从比较')
})

test('第 3 段：withAuth 校验 token 是否已作废', () => {
  assert.ok(/isTokenRevoked/.test(authSrc), 'withAuth 没有校验权限版本号')
  assert.ok(
    /PERMISSION_CHANGED/.test(authSrc),
    '踢人时没给出可区分的 code，前端只能笼统说「登录已过期」',
  )
  // 顺序要紧：先判作废再判权限点。反过来的话，权限被收窄的人会先吃 403，
  // 前端把 403 当成「你不该点这个」而不是「去重新登录」，用户会以为功能坏了。
  assert.ok(
    authSrc.indexOf('isTokenRevoked') < authSrc.indexOf('权限不足，需要角色'),
    '作废判定要排在权限点判定之前',
  )
})

test('旧 token（没有 pv）不会被判作废', () => {
  // 部署当天所有在线用户手里都是没有 pv 的旧 token。把它们判成过期
  // 等于把全公司踢下线一遍 —— eb50ebf 那次事故就是这个形状。
  assert.ok(
    /typeof payload\.pv !== 'number'/.test(permVersionSrc),
    '没有对旧 token 做豁免',
  )
})

test('permVersion 查询有缓存，否则每个请求多一次查库', () => {
  // 记忆「droplet 性能与容灾」：瓶颈是 CPU，2 vCPU 8 并发即饱和。
  // withAuth 原本零次查库，无缓存地加一次 SELECT 是全站每请求的成本。
  assert.ok(/TTL_MS/.test(permVersionSrc), '没有缓存')
  assert.ok(/cache\.delete/.test(permVersionSrc), '没有提供就地失效，改完要等缓存自然过期')
})

test('第 4 段：前端认 PERMISSION_CHANGED 并说清原因', () => {
  assert.ok(/PERMISSION_CHANGED/.test(apiSrc), 'lib/api.ts 没有区分这个 code')
  assert.ok(/reason=permission-changed/.test(apiSrc), '跳登录页时没带原因')
  assert.ok(/permission-changed/.test(enterSrc), '登录页不认这个原因，用户看不到解释')
  assert.ok(/权限已变更/.test(apiSrc), '没有给中文提示')
})
