/**
 * 刷新 lib/rbac/sortkeys.json —— 权限点位图序号的冻结快照。
 *
 * 为什么需要它：JWT 里的权限位图按 sortKey 定位。如果有人在 catalog 中间插入
 * 一个权限点，后面所有权限点的序号会整体后移 —— 已签发的 token 会**静默错位**，
 * 表现是用户突然拥有了别人的权限。这种 bug 不会报错，只会在生产上悄悄放权。
 *
 * 所以本快照是 sortKey 的**权威来源**，catalog.ts 的声明顺序不参与分配：
 *   - 已存在的权限点：号码原样保留，永不重算
 *   - 新增的权限点：一律取 max+1，与它在 catalog 里插在哪无关
 *   - 删除的权限点：号码进 retired，永不复用（否则旧 token 里那一位会指向新权限点）
 *
 * 用法：增删权限点后跑 `npx tsx scripts/rbac/sync-sortkeys.ts`。
 * 这是**显式动作** —— 改代码顺手把快照也改了的话，review 时看得见。
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PERMISSIONS } from '../../lib/rbac/catalog'

const SNAPSHOT_PATH = resolve(process.cwd(), 'lib/rbac/sortkeys.json')

interface Snapshot {
  /** 已作废（曾存在但已从 catalog 删除）的序号，不得复用 */
  retired: number[]
  /** 权限点 id → 冻结的 sortKey */
  keys: Record<string, number>
}

const prev: Snapshot = existsSync(SNAPSHOT_PATH)
  ? (JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as Snapshot)
  : { retired: [], keys: {} }

const currentIds = new Set(PERMISSIONS.map((p) => p.id))

// 已存在的权限点：号码原样保留，永不重算。
const keys: Record<string, number> = {}
for (const id of currentIds) {
  if (prev.keys[id] !== undefined) keys[id] = prev.keys[id]
}

// 删除的权限点：号码作废，不得被后来者复用（否则旧 token 里那一位会指向新权限点）。
const removed = Object.keys(prev.keys).filter((id) => !currentIds.has(id))
const retired = [...new Set([...prev.retired, ...removed.map((id) => prev.keys[id])])].sort(
  (a, b) => a - b,
)

// 新增的权限点：一律取 max+1，与它在 catalog 里的位置无关。
let nextKey = Math.max(-1, ...Object.values(prev.keys), ...retired) + 1
const added = PERMISSIONS.filter((p) => prev.keys[p.id] === undefined)
for (const p of added) keys[p.id] = nextKey++

const next: Snapshot = { retired, keys }

writeFileSync(SNAPSHOT_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8')

console.log(`✅ 快照已更新：${PERMISSIONS.length} 个权限点`)
if (added.length > 0) console.log(`   新增 ${added.length}：${added.map((p) => p.id).join(', ')}`)
if (removed.length > 0) console.log(`   删除 ${removed.length}：${removed.join(', ')}（序号作废）`)
