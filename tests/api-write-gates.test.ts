/**
 * 锁住「每个写操作都有角色闸」。
 *
 * 由来：2026-08-06 审计实测，一个餐厅客户账号能 `POST /api/pricelists` 并**真的创建成功**。
 * 根因是大量 handler 有 `withAuth` 但没传 `allowedRoles` —— 任何登录用户都能调。
 * 补完之后必须有东西守着，否则下一个新路由又是敞开的（这正是白名单泄露那次的教训：
 * 问题不是有人写错，而是**写错了没有任何测试会红**）。
 *
 * 这个测试不断言具体角色或权限点（那是业务决定，会变），只断言两件事：
 *   1. 每个写 handler 都有闸（权限点闸 / 遗留角色闸 / CRON 密钥），
 *      例外必须在下面显式登记并写明理由
 *   2. 登记的例外还在（写反了也要红 —— 免得例外表变成放行一切的后门）
 *
 * 20260807：闸门主体已从 allowedRoles 改为 { require: '权限点' }，两种都算有闸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scanApiHandlers, isWrite } from '../lib/route-gate-scan'

/**
 * 允许没有角色闸的写操作。每一条都要有理由。
 *
 * ⚠️ 往这里加一条之前先问：不限定角色的话，一个司机 / 分拣员 / 外部销售调用它会怎样？
 */
const EXEMPT: Record<string, string> = {
  'POST /api/notifications': '推通知给别人；闸在 middleware 层（system.notification.create）',
  'POST /api/upload-image': '上传图片；闸在 middleware 层（tool.upload.use）',
  'POST /api/demo/reset': '演示数据重置；闸在 middleware 层（system.settings.manage）',
  'POST /api/auth/login': '登录本身必须匿名可达，自带 rateLimit',
  'POST /api/auth/logout': '退出只删自己浏览器的 HttpOnly 登录 cookie，不碰任何业务数据；必须匿名可达（token 失效时也要能退出）',
  'POST /api/auth/change-password': '改自己的密码，用 requireAuth 取本人身份，无角色概念',
  'POST /api/cron/backup-database': '定时任务，走 CRON_SECRET 共享密钥（迁服务器后由 systemd timer 触发）',
  'POST /api/cron/generate-statements': '定时任务，走 CRON_SECRET 共享密钥，同上',
  'POST /api/action-logs/cleanup': '同上，走 CRON_SECRET',
  'POST /api/mfa/enroll': '给自己开二次验证',
  'DELETE /api/mfa/enroll': '关自己的二次验证',
  'PATCH /api/notifications': '标记自己的通知已读',
  'POST /api/geocode': '地址转坐标，纯转发第三方；调用方已被 middleware 的角色边界限定',
  'POST /api/distance-matrix': '同上，算两点距离',
  // 信息广场（DEV-PLAN 20260824 §3）：按设计不接正式权限点体系，所有内部登录用户
  // 都能发帖/带图；管理动作（删任意帖/置顶）在 handler 内部硬判断 BOSS/OPERATOR 角色
  // （lib/bulletin.ts canManageBulletin），扫描器识别不到这层运行时判断。
  // RESTAURANT 客户门户账号同样在 handler 内部单独挡掉（assertInternalUser）。
  'POST /api/bulletin-posts': '发帖，所有内部登录用户可用，闸在 handler 内部（assertInternalUser）',
  'POST /api/bulletin-posts/upload-image': '发帖配图上传，同上',
  'DELETE /api/bulletin-posts/[id]': '删自己的帖子人人可用；删别人的帖子闸在 handler 内部（canManageBulletin）',
  'PATCH /api/bulletin-posts/[id]/pin': '置顶/取消置顶，闸在 handler 内部（canManageBulletin，仅 BOSS/OPERATOR）',
}

test('每个写 handler 都有闸（例外必须登记）', () => {
  const ungated = scanApiHandlers()
    .filter(h => isWrite(h.verb))
    .filter(h => h.gate.kind !== 'permission' && h.gate.kind !== 'roles' && h.gate.kind !== 'cronSecret')
    .map(h => `${h.verb} ${h.route}`)
    .filter(k => !(k in EXEMPT))

  assert.deepEqual(
    ungated, [],
    `以下写操作没有闸 —— 任何登录用户都能调：\n` +
    ungated.map(k => `  ${k}`).join('\n') +
    `\n补 withAuth(req, handler, { require: '权限点' })，或在 EXEMPT 里登记并写清理由。`,
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

/**
 * 20260807：闸门从角色改成权限点后，这条测试也跟着升级 —— 而且变强了。
 * 以前看的是「闸门里写没写一线角色的名字」，现在直接查**该角色实际拥有的权限集**，
 * 绕不过去：就算哪天给一线角色悄悄加了权限点，这里照样会红。
 */
test('⛔ 删除类操作绝不能落到一线岗位手里', () => {
  const frontline = ['DRIVER', 'PICKER', 'SORTER', 'RESTAURANT', 'EXTERNAL_SALES']
  const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf8')) as {
    roles: Array<{ legacyRole: string; permissions: string[] }>
  }
  const permsOf = new Map(seed.roles.map(r => [r.legacyRole, new Set(r.permissions)]))
  const backOffice = ['OPERATOR', 'BOSS']

  for (const h of scanApiHandlers()) {
    if (h.verb !== 'DELETE' || h.gate.kind !== 'permission') continue
    if (`${h.verb} ${h.route}` in LINE_LEVEL_DELETES) continue
    const need = h.gate.permissions

    assert.ok(
      backOffice.some(r => need.some(p => permsOf.get(r)?.has(p))),
      `DELETE ${h.route} 要求 [${need}]，但 OPERATOR/BOSS 都没有 —— 删除必须后台够得着`,
    )
    for (const r of frontline) {
      const got = need.filter(p => permsOf.get(r)?.has(p))
      assert.equal(
        got.length, 0,
        `DELETE ${h.route} 要求 [${need}]，而 ${r} 拥有 [${got}] —— 一线岗位不该有删除权`,
      )
    }
  }
})

test('扫描器本身没坏（否则上面几条会静默通过）', () => {
  const all = scanApiHandlers()
  assert.ok(all.length > 200, `只扫到 ${all.length} 个 handler，扫描逻辑可能失效`)
  const gated = all.filter(h => h.gate.kind === 'permission')
  assert.ok(gated.length > 120, `只有 ${gated.length} 个 handler 被识别出权限闸，检测逻辑可能又漏了`)

  // 曾用具名常量 ALLOWED_ROLES 的路由，改写后必须仍被认出有闸 ——
  // 第一版正则只认内联数组，把 5 处用常量的路由误报成"没闸"，让整改清单虚高。
  const backup = all.find(h => h.route === '/api/backups' && h.verb === 'POST')
  assert.equal(backup?.gate.kind, 'permission', '/api/backups POST 的闸必须能识别')
  assert.deepEqual(
    backup?.gate.kind === 'permission' ? backup.gate.permissions : [],
    ['system.backup.manage'],
  )

  // 注释里的括号不能骗过配平 —— `// 1) …` 曾让两个 POST 被误判成"没闸"，
  // 同一个坑还让第一版批量改写脚本把角色数组插进了注释里。
  const orders = all.find(h => h.route === '/api/orders' && h.verb === 'POST')
  assert.equal(orders?.gate.kind, 'permission', '/api/orders POST 的闸必须能被识别')
  assert.deepEqual(
    orders?.gate.kind === 'permission' ? orders.gate.permissions : [],
    ['sales.order.create'],
  )
})
