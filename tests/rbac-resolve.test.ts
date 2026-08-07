import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combinePermissions, widestScope, type DataScope } from '../lib/rbac/resolve'
import { encodePermissions, decodePermissions } from '../lib/rbac/bitmap'
import { PERMISSIONS, PERMISSION_BITMAP_BYTES } from '../lib/rbac/catalog'

const role = (permissions: string[], dataScope: DataScope = 'ALL') => ({ permissions, dataScope })

test('多角色权限取并集', () => {
  const r = combinePermissions([
    role(['sales.order.read', 'sales.order.create']),
    role(['sales.order.read', 'purchase.order.read']),
  ])
  assert.deepEqual(
    r.permissions.sort(),
    ['purchase.order.read', 'sales.order.create', 'sales.order.read'],
  )
})

test('个人级例外可以加权限', () => {
  const r = combinePermissions(
    [role(['sales.order.read'])],
    [{ permissionId: 'dispatch.console.access', granted: true }],
  )
  assert.ok(r.permissions.includes('dispatch.console.access'), '「只有张三能进配送中心」靠这个')
})

test('个人级例外可以扣权限', () => {
  const r = combinePermissions(
    [role(['sales.order.read', 'sales.order.delete'])],
    [{ permissionId: 'sales.order.delete', granted: false }],
  )
  assert.ok(!r.permissions.includes('sales.order.delete'))
  assert.ok(r.permissions.includes('sales.order.read'))
})

test('同一权限点上 revoke 压过 grant', () => {
  const r = combinePermissions(
    [role([])],
    [
      { permissionId: 'sales.order.delete', granted: true },
      { permissionId: 'sales.order.delete', granted: false },
    ],
  )
  assert.deepEqual(r.permissions, [], '两条例外互相矛盾时按最保守的来')
})

test('catalog 里不存在的权限点被忽略', () => {
  const r = combinePermissions(
    [role(['sales.order.read', 'ghost.permission.nope'])],
    [{ permissionId: 'another.ghost.nope', granted: true }],
  )
  assert.deepEqual(r.permissions, ['sales.order.read'])
})

/**
 * 现网 19 个 SALES 全部兼任 OPERATOR。取最窄的话他们会突然只看得到自己的单 ——
 * 那不是平迁，是把业务改了。
 */
test('dataScope 取最宽', () => {
  assert.equal(widestScope(['OWN', 'ALL']), 'ALL')
  assert.equal(widestScope(['OWN', 'TEAM']), 'TEAM')
  assert.equal(widestScope(['TEAM', 'ALL']), 'ALL')
  assert.equal(widestScope(['OWN']), 'OWN')
})

test('没有任何角色时给最窄范围，不是最宽', () => {
  assert.equal(widestScope([]), 'OWN')
  assert.equal(combinePermissions([]).dataScope, 'OWN')
})

test('多角色 dataScope 合并', () => {
  const r = combinePermissions([role(['a'], 'OWN'), role(['b'], 'ALL')])
  assert.equal(r.dataScope, 'ALL')
})

// ── 位图 ──────────────────────────────────────────────────────────────────

test('位图编解码往返一致', () => {
  const ids = ['sales.order.read', 'purchase.order.approve', 'system.rbac.manage']
  const set = decodePermissions(encodePermissions(ids))
  for (const id of ids) assert.ok(set.has(id), `${id} 应该在位图里`)
  assert.ok(!set.has('sales.order.delete'))
  assert.deepEqual(set.toArray().sort(), [...ids].sort())
})

test('全部权限点的位图往返一致', () => {
  const all = PERMISSIONS.map((p) => p.id)
  const set = decodePermissions(encodePermissions(all))
  assert.equal(set.size, all.length)
  assert.deepEqual(set.toArray().sort(), [...all].sort())
})

test('空位图什么都没有', () => {
  const set = decodePermissions('')
  assert.equal(set.size, 0)
  assert.ok(!set.has('sales.order.read'))
  assert.ok(!decodePermissions(undefined).has('sales.order.read'))
  assert.ok(!decodePermissions(null).has('sales.order.read'))
})

test('位图不认得 catalog 外的 id', () => {
  const set = decodePermissions(encodePermissions(['ghost.nope.nope', 'sales.order.read']))
  assert.ok(!set.has('ghost.nope.nope'))
  assert.ok(set.has('sales.order.read'))
})

test('hasAny 任一命中', () => {
  const set = decodePermissions(encodePermissions(['sales.order.read']))
  assert.ok(set.hasAny(['nope.a.b', 'sales.order.read']))
  assert.ok(!set.hasAny(['nope.a.b', 'nope.c.d']))
  assert.ok(!set.hasAny([]))
})

/**
 * token 增量上限 100 字符。位图是 base64，4 个字符编 3 字节。
 */
test('位图体积在 JWT 预算内', () => {
  const all = encodePermissions(PERMISSIONS.map((p) => p.id))
  assert.equal(all.length, Math.ceil((PERMISSION_BITMAP_BYTES / 3) * 4))
  assert.ok(all.length < 100, `位图 ${all.length} 字符，超出 token 预算`)
})

/**
 * 位序错了不会报错，只会让用户拿到别人的权限。所以逐位验证一遍：
 * 只点亮第 N 位时，有且只有 sortKey=N 的那个权限点被认出来。
 */
test('每一位都精确对应一个权限点', () => {
  for (const p of PERMISSIONS) {
    const set = decodePermissions(encodePermissions([p.id]))
    assert.equal(set.size, 1, `${p.id} 点亮了不止一位`)
    assert.ok(set.has(p.id), `${p.id} 编进去又读不出来`)
  }
})
