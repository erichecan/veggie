/**
 * 锁住「角色 × 端点」的可达性矩阵。
 *
 * 审计那次的根因不是有人写错，而是**写错了没有任何测试会红**：
 * `/api/customers` 被加进公开白名单，全量客户名册匿名可读了两个月。
 * 这个测试把三层判定（公开白名单 / middleware 角色边界 / 路由 allowedRoles）
 * 合成一张表，与快照逐格比对 —— 任何一格从 n 变 y 都会失败并列出来。
 *
 * 快照更新必须是显式动作：
 *   npx tsx scripts/audit/save-reachability.ts
 * 这样 review 时能一眼看到「这次改动让谁多够到了什么」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildReachabilityMatrix, PROBE_ROLES, type Reach } from '../lib/role-reachability'

const SNAPSHOT = 'scripts/audit/role-reachability.json'

test('可达性矩阵与快照一致', () => {
  const now = buildReachabilityMatrix()
  const prev: Record<string, Record<string, Reach>> = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))

  const opened: string[] = []   // 变得更开放 —— 这类必须逐条解释
  const closed: string[] = []   // 收紧了 —— 通常是好事，但也要确认不是误伤
  const added: string[] = []
  const removed: string[] = []

  for (const key of Object.keys(now)) {
    if (!(key in prev)) { added.push(key); continue }
    for (const role of PROBE_ROLES) {
      const a = prev[key][role], b = now[key][role]
      if (a === b) continue
      ;(b === 'y' || b === 'anon' ? opened : closed).push(`  ${key} [${role}] ${a} → ${b}`)
    }
  }
  for (const key of Object.keys(prev)) if (!(key in now)) removed.push(key)

  const problems = [
    opened.length ? `⛔ 变得更开放（${opened.length} 格）：\n${opened.join('\n')}` : '',
    closed.length ? `收紧（${closed.length} 格）：\n${closed.join('\n')}` : '',
    added.length ? `新增 handler（${added.length}）：\n  ${added.join('\n  ')}` : '',
    removed.length ? `已删除 handler（${removed.length}）：\n  ${removed.join('\n  ')}` : '',
  ].filter(Boolean).join('\n\n')

  assert.equal(
    problems, '',
    `角色可达性发生变化：\n\n${problems}\n\n` +
    `确认每一处都是有意为之之后，跑 npx tsx scripts/audit/save-reachability.ts 更新快照。\n` +
    `⚠️ 「变得更开放」的那些必须在提交信息里说明理由。`,
  )
})

test('⛔ 匿名可达的必须只有这 6 条 —— 泄露客户名册那次就是这里破的', () => {
  const now = buildReachabilityMatrix()
  const anon = Object.entries(now)
    .filter(([, row]) => row.BOSS === 'anon')
    .map(([k]) => k.split(' ')[1])
  // logout 只删自己浏览器的登录 cookie，不吐任何业务数据；
  // generate-statements 与 backup-database 同类，走 CRON_SECRET 共享密钥而非角色
  assert.deepEqual([...new Set(anon)].sort(), [
    '/api/auth/login', '/api/auth/logout', '/api/cron/backup-database', '/api/cron/generate-statements', '/api/health', '/api/tile',
  ])
})

test('⛔ 餐厅客户在整张表里只够得着客户门户', () => {
  const now = buildReachabilityMatrix()
  const reachable = Object.entries(now)
    .filter(([, row]) => row.RESTAURANT === 'y')
    .map(([k]) => k)
  for (const k of reachable) {
    const path = k.split(' ')[1]
    assert.ok(
      /^\/api\/(customer-portal|auth|health|notifications)\b/.test(path),
      `RESTAURANT 够得着 ${k} —— 边界只该放行客户门户与登录/通知`,
    )
  }
})
