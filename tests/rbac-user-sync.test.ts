import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 用户管理这条链路上的静态检查。
 *
 * 这些都是「写错了不会报错、只会静默失效」的地方：
 *   - 角色白名单漏了某个角色 → 管理员根本设不了它（EXTERNAL_SALES 就漏了两个月）
 *   - 改角色不同步 UserRoleLink → 页面上改了、权限纹丝不动（「配了但不生效」）
 *   - 建用户不建 UserRoleLink → 账号建出来了，登录后什么都点不动
 */

const putSrc = readFileSync('app/api/users/[id]/route.ts', 'utf-8')
const postSrc = readFileSync('app/api/users/route.ts', 'utf-8')
const schema = readFileSync('prisma/schema.prisma', 'utf-8')

/** prisma enum Role 里的全部角色 */
const ENUM_ROLES = (() => {
  const block = schema.match(/enum Role \{([\s\S]*?)\}/)![1]
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z_]+$/.test(l))
})()

function validRolesIn(src: string): string[] {
  const m = src.match(/const VALID_ROLES = \[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])
}

test('权限中心分配角色时，legacy 列只写 enum 里存在的角色', () => {
  // 自定义角色的 code（office_sales 之类）不在 enum Role 里。不过滤就直接写库的话，
  // Prisma 抛 PrismaClientValidationError，表现是「新建的角色一分配给用户就 500」——
  // 正好把可配置权限最核心的一步打死。实测踩到过。
  const src = readFileSync('app/api/rbac/users/[id]/route.ts', 'utf-8')
  const m = src.match(/const LEGACY_ROLES = \[([\s\S]*?)\] as const/)
  assert.ok(m, '没有 LEGACY_ROLES 白名单，说明又在无条件 toUpperCase 后写库')
  const listed = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])
  assert.deepEqual(
    ENUM_ROLES.filter((r) => !listed.includes(r)), [],
    'LEGACY_ROLES 漏了 enum 里的角色，挂上它的人 legacy 列会被清空',
  )
  assert.deepEqual(
    listed.filter((r) => !ENUM_ROLES.includes(r)), [],
    'LEGACY_ROLES 里有 enum 不认的角色，写库照样会炸',
  )
})

test('创建与修改用户的角色白名单，都要覆盖 enum Role 的全部角色', () => {
  for (const [label, src] of [['POST /api/users', postSrc], ['PUT /api/users/[id]', putSrc]] as const) {
    const allowed = validRolesIn(src)
    const missing = ENUM_ROLES.filter((r) => !allowed.includes(r))
    assert.deepEqual(missing, [], `${label} 的白名单漏了这些角色，管理员设不了它们`)
    const extra = allowed.filter((r) => !ENUM_ROLES.includes(r))
    assert.deepEqual(extra, [], `${label} 的白名单里有 enum 里不存在的角色`)
  }
})

test('改角色时必须同步 UserRoleLink，否则「配了但不生效」', () => {
  assert.ok(
    /syncRoleLinks\s*\(/.test(putSrc) && /userRoleLink\.deleteMany/.test(putSrc),
    'PUT /api/users/[id] 改了 roles[] 却没同步 UserRoleLink',
  )
})

test('改角色后必须 bump permVersion，逼对方重新登录', () => {
  assert.ok(
    /permVersion:\s*\{\s*increment:\s*1\s*\}/.test(putSrc),
    '权限变了但没作废对方手里的 token —— 旧 token 最长还能用 7 天',
  )
})

test('建用户时必须建 UserRoleLink，否则新账号什么都点不动', () => {
  assert.ok(
    /userRoleLink\.createMany/.test(postSrc),
    'POST /api/users 建了账号却没建角色链接',
  )
})

test('设上级必须防成环', () => {
  assert.ok(/wouldFormCycle/.test(putSrc), '没有环检测')
  assert.ok(/不能把自己设为自己的上级/.test(putSrc), '没挡住自己指向自己')
})
