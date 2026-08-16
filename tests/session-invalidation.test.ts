import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 账号凭据/状态变更后，旧 token 必须立刻失效（X10 及其外溢）。
 *
 * 为什么需要这组测试 —— 一条容易被反复踩中的事实：
 *
 *   `withAuth` 是**纯验签 + permVersion 比对**，全程不查 `isActive`。
 *   `isActive` 只在 `app/api/auth/login/route.ts` 登录那一刻校验一次。
 *   而 token 有效期是 **7 天**（lib/auth.ts setExpirationTime('7d')）。
 *
 * 于是「把账号停掉」这个动作，如果只写 `isActive: false`，实际效果是
 * **挡住下一次登录，但放行手上那张 token 整整 7 天**。
 * 离职当天停用、第二天照样下单，就是这么来的。
 *
 * 真正把人踢出去的唯一一下是 `permVersion: { increment: 1 }`，
 * 再配一次 `forgetPermVersions()` 清掉 withAuth 那侧 30 秒的缓存。
 *
 * 所以这组测试守的是**结构**而不是某一个接口：凡是动 user 的密码或启用状态的
 * 路由文件，都必须出现 permVersion 自增。新写一个忘了带，这里就红。
 */

const API_ROOT = 'app/api'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const routeFiles = walk(API_ROOT).map((path) => ({ path, src: readFileSync(path, 'utf-8') }))

/** 这个文件是否在改 user 表 */
const writesUser = (src: string) => /\b(prisma|p)\.user\.(update|updateMany)\(/.test(src)
/**
 * 是否在**设**一个新密码。
 * ⚠️ 不能只看 `passwordHash` 这个词：登录接口 select 出哈希做 `bcrypt.compare`，
 * 那是读不是写，算进来会得到一条假的违规。判据是「产生了新哈希」——
 * `bcrypt.hash(`，或写入不可用占位串那种字面量。
 */
const setsPassword = (src: string) => /bcrypt\.hash\(/.test(src) || /passwordHash:\s*'/.test(src)
const bumpsPermVersion = (src: string) => /permVersion:\s*\{\s*increment:\s*1\s*\}/.test(src)

// ── 结构不变量 ────────────────────────────────────────────────────────────

test('凡是改 user 密码的路由，都必须作废旧 token', () => {
  const offenders = routeFiles
    .filter((f) => writesUser(f.src) && setsPassword(f.src))
    .filter((f) => !bumpsPermVersion(f.src))
    .map((f) => f.path)

  assert.deepEqual(
    offenders,
    [],
    `这些接口改了密码却没有 permVersion +1，旧 token 还能用满 7 天：\n  ${offenders.join('\n  ')}`,
  )
})

test('凡是停用 user 的路由，都必须作废旧 token', () => {
  const offenders = routeFiles
    .filter((f) => writesUser(f.src) && /isActive:\s*false/.test(f.src))
    .filter((f) => !bumpsPermVersion(f.src))
    .map((f) => f.path)

  assert.deepEqual(
    offenders,
    [],
    `这些接口停用了账号却没有 permVersion +1 —— isActive 只在登录时查，\n` +
      `停用等于只挡下一次登录，手上的 token 照样能用：\n  ${offenders.join('\n  ')}`,
  )
})

test('作废 token 的地方要同时清缓存，否则还有 30 秒窗口', () => {
  const offenders = routeFiles
    .filter((f) => bumpsPermVersion(f.src))
    .filter((f) => !/forgetPermVersions\(/.test(f.src))
    .map((f) => f.path)

  // 自助改密是唯一豁免：改完本来就要求本人重新登录，且它改的是自己，
  // 30 秒后自然失效，不值得为它多查一次库。
  assert.deepEqual(
    offenders.filter((p) => !p.includes('auth/change-password')),
    [],
    `permVersion 改了但没清缓存：\n  ${offenders.join('\n  ')}`,
  )
})

// ── 强度校验：管理员那条路不能比自助那条松 ────────────────────────────────

test('管理员替别人设密码，走的是同一个 assessNewPassword', () => {
  const put = readFileSync('app/api/users/[id]/route.ts', 'utf-8')
  assert.ok(
    /assessNewPassword\(/.test(put),
    '管理员改密没过强度校验 —— 松的恰恰是设置别人密码的那条路',
  )
})

test('建号时的初始密码也过同一个校验', () => {
  const post = readFileSync('app/api/users/route.ts', 'utf-8')
  assert.ok(
    /assessNewPassword\(/.test(post),
    '建号没做强度校验 —— 生产上那 42 个 test123 就是从这条路进来的',
  )
})

test('不再有 length >= 6 这种和策略对不上的旧口径', () => {
  for (const path of ['app/api/users/[id]/route.ts', 'app/api/users/route.ts']) {
    const src = readFileSync(path, 'utf-8')
    assert.ok(
      !/密码至少 6 位/.test(src),
      `${path} 还留着 6 位的旧口径，与 PASSWORD_MIN_LENGTH=10 直接矛盾`,
    )
  }
})

// ── 前端与后端的口径必须一致 ──────────────────────────────────────────────

const PASSWORD_UI = [
  'app/[locale]/classic/operator/users/users-tab.tsx',
  'components/classic/OdooNav.tsx',
  'components/shared/nav.tsx',
  'app/[locale]/change-password/page.tsx',
]

test('前端不得自己另写一套长度口径', () => {
  for (const path of PASSWORD_UI) {
    const src = readFileSync(path, 'utf-8')
    assert.ok(
      !/\.length\s*<\s*6\b/.test(src),
      `${path} 还在用 6 位判断 —— 前端放行、后端打回，用户看到的是「填对了却报错」`,
    )
    assert.ok(
      !/至少 6 位|at least 6 characters|min 6 chars/.test(src),
      `${path} 的提示文案还写着 6 位`,
    )
  }
})

test('调改密接口的地方，字段名必须是 currentPassword', () => {
  // 接口 destructure 的是 currentPassword。写成 oldPassword 不会报类型错，
  // 只会在运行时变成 undefined —— 表现为「修改密码」永远提示请填写当前密码。
  for (const path of PASSWORD_UI) {
    const src = readFileSync(path, 'utf-8')
    if (!/api\/auth\/change-password/.test(src)) continue
    assert.ok(
      !/oldPassword:/.test(src),
      `${path} 发的是 oldPassword，后端读 currentPassword —— 这个改密入口是死的`,
    )
  }
})

// ── 这组测试成立的前提，写成断言 ──────────────────────────────────────────

test('前提：withAuth 确实不查 isActive —— 变了就回来简化上面的规则', () => {
  const authSrc = readFileSync('lib/auth.ts', 'utf-8')
  assert.ok(
    !/isActive/.test(authSrc),
    'withAuth 开始查 isActive 了。那么「停用必须 permVersion+1」这条就不再是唯一手段，' +
      '本文件的规则应当重新评估，而不是继续照抄。',
  )
})
