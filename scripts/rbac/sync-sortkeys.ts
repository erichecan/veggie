/**
 * 刷新 lib/rbac/sortkeys.json —— 权限点位图序号的冻结快照。
 *
 * 为什么需要它：JWT 里的权限位图按 sortKey 定位。如果有人在 catalog 中间插入
 * 一个权限点，后面所有权限点的序号会整体后移 —— 已签发的 token 会**静默错位**，
 * 表现是用户突然拥有了别人的权限。这种 bug 不会报错，只会在生产上悄悄放权。
 *
 * 所以 sortKey 一经分配就冻结在这个文件里，`tests/rbac-catalog.test.ts` 比对：
 *   - 已存在的权限点：sortKey 必须与快照一致（改了 → 测试失败）
 *   - 新增的权限点：只能拿比快照最大值更大的号
 *   - 删除的权限点：允许，但它的号作废，不得被复用
 *
 * 用法：新增权限点后跑 `npx tsx scripts/rbac/sync-sortkeys.ts`。
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

const current = new Map(PERMISSIONS.map((p) => [p.id, p.sortKey]))

const drifted: string[] = []
for (const [id, oldKey] of Object.entries(prev.keys)) {
  const nowKey = current.get(id)
  if (nowKey !== undefined && nowKey !== oldKey) {
    drifted.push(`${id}: ${oldKey} → ${nowKey}`)
  }
}

if (drifted.length > 0) {
  console.error('⛔ 以下权限点的 sortKey 发生了漂移，已签发的 token 会错位：\n')
  drifted.forEach((d) => console.error('   ' + d))
  console.error(
    '\n新增权限点只能追加到所属模块的末尾。请调整 catalog.ts 的声明顺序后重跑。',
  )
  process.exit(1)
}

const removed = Object.keys(prev.keys).filter((id) => !current.has(id))
const retired = [...new Set([...prev.retired, ...removed.map((id) => prev.keys[id])])].sort(
  (a, b) => a - b,
)

const next: Snapshot = {
  retired,
  keys: Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.sortKey])),
}

writeFileSync(SNAPSHOT_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8')

const added = PERMISSIONS.filter((p) => prev.keys[p.id] === undefined)
console.log(`✅ 快照已更新：${PERMISSIONS.length} 个权限点`)
if (added.length > 0) console.log(`   新增 ${added.length}：${added.map((p) => p.id).join(', ')}`)
if (removed.length > 0) console.log(`   删除 ${removed.length}：${removed.join(', ')}（序号作废）`)
