import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_COUNT,
  PERMISSION_BITMAP_BYTES,
  PERMISSION_BY_ID,
  isKnownPermission,
  expandPermissionPattern,
} from '../lib/rbac/catalog'

interface Snapshot {
  retired: number[]
  keys: Record<string, number>
}

const snapshot: Snapshot = JSON.parse(
  readFileSync(resolve(process.cwd(), 'lib/rbac/sortkeys.json'), 'utf-8'),
) as Snapshot

test('权限点 id 唯一', () => {
  const ids = PERMISSIONS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, '存在重复的权限点 id')
})

test('sortKey 唯一且非负', () => {
  const keys = PERMISSIONS.map((p) => p.sortKey)
  assert.equal(new Set(keys).size, keys.length, '两个权限点占了同一个位图位')
  const unassigned = PERMISSIONS.filter((p) => p.sortKey < 0).map((p) => p.id)
  assert.deepEqual(
    unassigned,
    [],
    '这些权限点还没有位图序号；请跑 npx tsx scripts/rbac/sync-sortkeys.ts',
  )
})

/**
 * sortKey 允许有空洞 —— 删掉的权限点其序号进 retired 且永不复用，
 * 压缩空洞就等于重排，会让已签发的 token 错位。
 */
test('sortKey 的空洞只能是已作废的号', () => {
  const used = new Set(PERMISSIONS.map((p) => p.sortKey))
  const retired = new Set(snapshot.retired)
  const max = Math.max(...used)
  const unexplained: number[] = []
  for (let i = 0; i <= max; i++) {
    if (!used.has(i) && !retired.has(i)) unexplained.push(i)
  }
  assert.deepEqual(unexplained, [], '这些序号既没被使用也没被作废，说明快照与 catalog 不同步')
})

test('PERMISSION_COUNT 与实际数量一致', () => {
  assert.equal(PERMISSION_COUNT, PERMISSIONS.length)
})

/**
 * 这条是整个权限体系的安全绳：sortKey 漂移会让**已签发的 token 静默错位**，
 * 用户凭空获得别人的权限，而且不报任何错。
 * sortKey 由快照决定、与声明位置无关，所以正常改 catalog 不会触发这条；
 * 它拦的是有人手改了 sortkeys.json，或绕过 sync 脚本自行赋号。
 */
test('已冻结的 sortKey 不得漂移', () => {
  const drifted: string[] = []
  for (const [id, frozenKey] of Object.entries(snapshot.keys)) {
    const def = PERMISSION_BY_ID.get(id)
    if (def && def.sortKey !== frozenKey) {
      drifted.push(`${id}: 快照 ${frozenKey} → 当前 ${def.sortKey}`)
    }
  }
  assert.deepEqual(drifted, [], '权限点 sortKey 漂移，已签发的 token 会错位')
})

test('新增权限点不得复用已作废的序号', () => {
  const retired = new Set(snapshot.retired)
  const reused = PERMISSIONS.filter(
    (p) => retired.has(p.sortKey) && snapshot.keys[p.id] === undefined,
  ).map((p) => p.id)
  assert.deepEqual(reused, [], '这些新权限点占用了已作废的序号')
})

test('快照与 catalog 数量一致（漏跑 sync-sortkeys 会失败）', () => {
  const inSnapshot = Object.keys(snapshot.keys).length
  assert.equal(
    inSnapshot,
    PERMISSION_COUNT,
    `catalog 有 ${PERMISSION_COUNT} 个权限点但快照里有 ${inSnapshot} 个；请跑 npx tsx scripts/rbac/sync-sortkeys.ts`,
  )
})

test('id 由 module 与 action 拼成', () => {
  for (const p of PERMISSIONS) {
    assert.equal(p.id, `${p.module}.${p.action}`, `${p.id} 的 id 与 module/action 不一致`)
  }
})

test('模块名唯一（同一模块不得分散在两个组里）', () => {
  const modules = PERMISSION_GROUPS.flatMap((g) => g.modules.map((m) => m.module))
  assert.equal(new Set(modules).size, modules.length, '存在重复定义的模块')
})

test('每个模块至少有一个动作', () => {
  for (const g of PERMISSION_GROUPS) {
    for (const m of g.modules) {
      assert.ok(m.actions.length > 0, `模块 ${m.module} 没有任何动作`)
    }
  }
})

test('同一模块内动作不重复', () => {
  for (const g of PERMISSION_GROUPS) {
    for (const m of g.modules) {
      const actions = m.actions.map((a) => a.action)
      assert.equal(new Set(actions).size, actions.length, `模块 ${m.module} 有重复动作`)
    }
  }
})

test('isKnownPermission 认得真权限点、认不出假的', () => {
  assert.ok(isKnownPermission('sales.order.create'))
  assert.ok(!isKnownPermission('sales.order.nonexistent'))
  assert.ok(!isKnownPermission(''))
})

test('expandPermissionPattern 展开模块通配', () => {
  const expanded = expandPermissionPattern('sales.order.*')
  assert.deepEqual(expanded, [
    'sales.order.read',
    'sales.order.create',
    'sales.order.update',
    'sales.order.delete',
    'sales.order.confirm',
    'sales.order.cancel',
  ])
  assert.deepEqual(expandPermissionPattern('sales.order.create'), ['sales.order.create'])
  assert.deepEqual(expandPermissionPattern('nope.nope.*'), [])
  assert.deepEqual(expandPermissionPattern('nope.nope.nope'), [])
})

/**
 * 位图长度直接决定 JWT 体积。设计上限是「token 增量 < 100 字符」，
 * 权限点涨到 600 个以上就会突破，届时要改设计（分段位图或改回查库）。
 */
test('位图长度在设计容量内', () => {
  assert.ok(
    PERMISSION_BITMAP_BYTES <= 75,
    `位图已 ${PERMISSION_BITMAP_BYTES} 字节（约 ${Math.ceil((PERMISSION_BITMAP_BYTES / 3) * 4)} 个 base64 字符），` +
      '超出「token 增量 < 100 字符」的设计上限，需重新评估 JWT 方案',
  )
})
