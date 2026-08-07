import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_COUNT,
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

test('sortKey 从 0 起连续、无重复、无空洞', () => {
  const keys = PERMISSIONS.map((p) => p.sortKey)
  assert.deepEqual(
    keys,
    keys.map((_, i) => i),
    'sortKey 必须是 0..n-1 的连续序列（位图按它定位）',
  )
})

test('PERMISSION_COUNT 与实际数量一致', () => {
  assert.equal(PERMISSION_COUNT, PERMISSIONS.length)
})

/**
 * 这条是整个权限体系的安全绳：sortKey 漂移会让**已签发的 token 静默错位**，
 * 用户凭空获得别人的权限，而且不报任何错。
 * 新增权限点只能追加到所属模块末尾；追加后跑 `npx tsx scripts/rbac/sync-sortkeys.ts`。
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
test('权限点总数在位图设计容量内', () => {
  assert.ok(
    PERMISSION_COUNT <= 600,
    `权限点 ${PERMISSION_COUNT} 个已超出位图设计容量，需重新评估 JWT 方案`,
  )
})
