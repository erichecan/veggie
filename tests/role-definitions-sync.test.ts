/**
 * 角色定义三处必须一致。
 *
 * 由来（2026-08-06 审计）：`prisma/schema.prisma` 的 `enum Role` 与 `lib/types.ts` 的
 * `UserRole` 都是 11 个，而 `lib/permissions.ts` 的 `Role` 只有 9 个 ——
 * 少了 `DISPATCH` 和 `OTHER`。`MATRIX` 是 `Record<Role, …>`，查 `MATRIX['DISPATCH']`
 * 会得到 `undefined`，只是当时恰好没有用户是这两种角色才没暴露。
 *
 * 这类问题靠人盯是盯不住的（三个文件、改一处很容易忘另两处），所以用测试钉死。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function rolesFromSchema(): string[] {
  const src = readFileSync('prisma/schema.prisma', 'utf8')
  const m = src.match(/enum Role \{([^}]*)\}/)
  assert.ok(m, 'schema.prisma 里找不到 enum Role')
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/\/.*$/, '').trim())   // 去掉 /// 文档注释
    .filter((l) => /^[A-Z_]+$/.test(l))
    .sort()
}

function rolesFromTypes(): string[] {
  const src = readFileSync('lib/types.ts', 'utf8')
  const m = src.match(/export type UserRole =([^\n]*)/)
  assert.ok(m, 'lib/types.ts 里找不到 UserRole')
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort()
}

function rolesFromPermissions(): string[] {
  const src = readFileSync('lib/permissions.ts', 'utf8')
  const m = src.match(/export type Role =([\s\S]*?)\n\nexport type Action/)
  assert.ok(m, 'lib/permissions.ts 里找不到 Role')
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort()
}

/** MATRIX 里实际写了哪些角色的条目 */
function rolesInMatrix(): string[] {
  const src = readFileSync('lib/permissions.ts', 'utf8')
  const m = src.match(/const MATRIX: Record<Role, Partial<Record<Subject, Action\[\]>>> = \{([\s\S]*?)\n\}/)
  assert.ok(m, '找不到 MATRIX')
  return [...m[1].matchAll(/^\s{2}([A-Z_]+):/gm)].map((x) => x[1]).sort()
}

describe('角色定义三处同步', () => {
  test('schema.prisma 与 lib/types.ts 一致', () => {
    assert.deepEqual(rolesFromTypes(), rolesFromSchema())
  })

  test('schema.prisma 与 lib/permissions.ts 一致', () => {
    assert.deepEqual(rolesFromPermissions(), rolesFromSchema())
  })

  test('⛔ MATRIX 必须给每个角色都写条目 —— 缺了会静默变成 undefined', () => {
    const declared = rolesFromSchema()
    const inMatrix = rolesInMatrix()
    const missing = declared.filter((r) => !inMatrix.includes(r))
    assert.deepEqual(missing, [], `MATRIX 缺少这些角色的条目: ${missing.join(', ')}`)
  })

  test('本次新增的角色确实在位', () => {
    const roles = rolesFromSchema()
    for (const r of ['DISPATCH', 'EXTERNAL_SALES', 'OTHER']) {
      assert.ok(roles.includes(r), `${r} 应存在于 enum Role`)
    }
  })
})

describe('新角色的权限边界', () => {
  test('外部合作销售拿不到发票与价格表', async () => {
    const { can } = await import('../lib/permissions')
    const ext = { role: 'EXTERNAL_SALES' as const }
    assert.equal(can(ext, 'read', 'invoice'), false, '外部销售不该看发票（含账期与欠款）')
    assert.equal(can(ext, 'read', 'pricelist'), false, '外部销售不该看整套价格体系')
    assert.equal(can(ext, 'update', 'customer'), false, '外部销售不该改客户资料')
    // 但该有的要有
    assert.equal(can(ext, 'read', 'product'), true)
    assert.equal(can(ext, 'read', 'order'), true)
    assert.equal(can(ext, 'create', 'order'), true)
  })

  test('正式销售保留原有权限，未被误伤', async () => {
    const { can } = await import('../lib/permissions')
    const sales = { role: 'SALES' as const }
    assert.equal(can(sales, 'read', 'invoice'), true)
    assert.equal(can(sales, 'read', 'pricelist'), true)
    assert.equal(can(sales, 'update', 'customer'), true)
  })

  test('调度能排波次派车，但不碰钱', async () => {
    const { can } = await import('../lib/permissions')
    const d = { role: 'DISPATCH' as const }
    assert.equal(can(d, 'update', 'wave'), true)
    assert.equal(can(d, 'update', 'trip'), true)
    assert.equal(can(d, 'update', 'order'), true)
    assert.equal(can(d, 'read', 'invoice'), false)
    assert.equal(can(d, 'read', 'analytics'), false)
  })

  test('OTHER 什么都不能做', async () => {
    const { can } = await import('../lib/permissions')
    const o = { role: 'OTHER' as const }
    for (const s of ['order', 'customer', 'product', 'invoice'] as const) {
      assert.equal(can(o, 'read', s), false, `OTHER 不该能读 ${s}`)
    }
  })
})
