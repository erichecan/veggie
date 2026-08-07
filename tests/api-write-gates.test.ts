/**
 * 锁住「每个写操作都有角色闸」。
 *
 * 由来：2026-08-06 审计实测，一个餐厅客户账号能 `POST /api/pricelists` 并**真的创建成功**。
 * 根因是大量 handler 有 `withAuth` 但没传 `allowedRoles` —— 任何登录用户都能调。
 * 补完之后必须有东西守着，否则下一个新路由又是敞开的（这正是白名单泄露那次的教训：
 * 问题不是有人写错，而是**写错了没有任何测试会红**）。
 *
 * 这个测试不断言具体角色（那是业务决定，会变），只断言两件事：
 *   1. 每个写 handler 都有闸（角色闸 / CRON 密钥），例外必须在下面显式登记并写明理由
 *   2. 登记的例外还在（写反了也要红 —— 免得例外表变成放行一切的后门）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanApiHandlers, isWrite } from '../lib/route-gate-scan'

/**
 * 允许没有角色闸的写操作。每一条都要有理由。
 *
 * ⚠️ 往这里加一条之前先问：不限定角色的话，一个司机 / 分拣员 / 外部销售调用它会怎样？
 */
const EXEMPT: Record<string, string> = {
  'POST /api/auth/login': '登录本身必须匿名可达，自带 rateLimit',
  'POST /api/auth/change-password': '改自己的密码，用 requireAuth 取本人身份，无角色概念',
  'POST /api/cron/backup-database': '定时任务，走 CRON_SECRET 共享密钥（迁服务器后由 systemd timer 触发）',
  'POST /api/action-logs/cleanup': '同上，走 CRON_SECRET',
  'POST /api/mfa/enroll': '给自己开二次验证',
  'DELETE /api/mfa/enroll': '关自己的二次验证',
  'PATCH /api/notifications': '标记自己的通知已读',
  'POST /api/geocode': '地址转坐标，纯转发第三方；调用方已被 middleware 的角色边界限定',
  'POST /api/distance-matrix': '同上，算两点距离',
}

test('每个写 handler 都有角色闸（例外必须登记）', () => {
  const ungated = scanApiHandlers()
    .filter(h => isWrite(h.verb))
    .filter(h => h.gate.kind !== 'roles' && h.gate.kind !== 'cronSecret')
    .map(h => `${h.verb} ${h.route}`)
    .filter(k => !(k in EXEMPT))

  assert.deepEqual(
    ungated, [],
    `以下写操作没有角色限制 —— 任何登录用户都能调：\n` +
    ungated.map(k => `  ${k}`).join('\n') +
    `\n补 withAuth(req, handler, ['角色…'])，或在 EXEMPT 里登记并写清理由。`,
  )
})

test('例外表里的条目仍然存在（免得例外表烂掉变成后门）', () => {
  const actual = new Set(scanApiHandlers().map(h => `${h.verb} ${h.route}`))
  for (const key of Object.keys(EXEMPT)) {
    assert.ok(actual.has(key), `例外表里的 ${key} 已不存在，请删掉这条登记`)
  }
})

/**
 * 「删一行」不等于「删一单」：改单据内容是销售的日常动作，
 * 与删除整条记录不是一回事，所以单列出来。
 */
const LINE_LEVEL_DELETES: Record<string, string> = {
  'DELETE /api/orders/[id]/lines/[lineId]': '删订单里的一行 = 编辑单据内容，销售本来就在做；删整单仍只给 OPERATOR/BOSS',
}

test('⛔ 删除类操作绝不能只给到一线岗位', () => {
  const frontline = ['DRIVER', 'PICKER', 'SORTER', 'RESTAURANT', 'EXTERNAL_SALES']
  for (const h of scanApiHandlers()) {
    if (h.verb !== 'DELETE' || h.gate.kind !== 'roles') continue
    if (`${h.verb} ${h.route}` in LINE_LEVEL_DELETES) continue
    const hasBackOffice = h.gate.roles.some(r => ['OPERATOR', 'BOSS'].includes(r))
    assert.ok(hasBackOffice,
      `DELETE ${h.route} 的角色是 [${h.gate.roles}] —— 删除必须至少要求 OPERATOR/BOSS`)
    for (const r of h.gate.roles) {
      if (frontline.includes(r)) {
        assert.fail(`DELETE ${h.route} 放开给了 ${r} —— 一线岗位不该有删除权`)
      }
    }
  }
})

test('扫描器本身没坏（否则上面几条会静默通过）', () => {
  const all = scanApiHandlers()
  assert.ok(all.length > 200, `只扫到 ${all.length} 个 handler，扫描逻辑可能失效`)
  const gated = all.filter(h => h.gate.kind === 'roles')
  assert.ok(gated.length > 80, `只有 ${gated.length} 个 handler 被识别出角色闸，检测逻辑可能又漏了`)

  // 具名常量写法必须能被识别 —— 第一版正则只认内联数组，
  // 把 5 处用常量的路由误报成"没闸"，让整改清单虚高。
  const backup = all.find(h => h.route === '/api/backups' && h.verb === 'POST')
  assert.equal(backup?.gate.kind, 'roles', '/api/backups 用的是具名常量 ALLOWED_ROLES，必须能识别')
  assert.deepEqual(backup?.gate.kind === 'roles' ? backup.gate.roles : [], ['BOSS'])

  // 注释里的括号不能骗过配平 —— `// 1) …` 曾让两个 POST 被误判
  const orders = all.find(h => h.route === '/api/orders' && h.verb === 'POST')
  assert.equal(orders?.gate.kind, 'roles', '/api/orders POST 的角色闸必须能被识别')
})
