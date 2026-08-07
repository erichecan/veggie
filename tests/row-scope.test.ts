/**
 * 行级隔离规则。
 *
 * 这层踩过两次，两次都是「条件在某个分支下被悄悄丢掉」：
 *   20260802  /api/customers：条件 push 在 where 构造之后，where 退化成 {} 时整段失效
 *   20260806  buildOrdersWhere：写成 if (!salesUserId)，请求带上 ?salesUserId=别人 就绕过
 * 所以这里不只测「规则对不对」，更要测「条件塞进 where 之后还在不在」。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { salesRowScope, withRowScope, isRowVisible, scopeCondition } from '../lib/row-scope'

const ME = 'user-me'
const OTHER = 'user-other'

describe('谁被隔离', () => {
  test('EXTERNAL_SALES 无条件隔离 —— 兼任别的角色也照隔', () => {
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['EXTERNAL_SALES'] }), { kind: 'own', userId: ME })
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['EXTERNAL_SALES', 'OPERATOR'] }), { kind: 'own', userId: ME })
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['BOSS', 'EXTERNAL_SALES'] }), { kind: 'own', userId: ME })
  })

  test('SALES 兼任 OPERATOR/BOSS 时不隔离 —— 这是决策，不是漏判', () => {
    // 生产上 19 个 SALES 全部兼任 OPERATOR，业务上就是要看全量。
    // 改成"只要有 SALES 就隔离"会让这 19 个人第二天打不开客户列表。
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['SALES'] }), { kind: 'own', userId: ME })
    assert.equal(salesRowScope({ userId: ME, roles: ['SALES', 'OPERATOR'] }), null)
    assert.equal(salesRowScope({ userId: ME, roles: ['SALES', 'BOSS'] }), null)
  })

  test('其他角色不隔离', () => {
    for (const r of ['OPERATOR', 'BOSS', 'FINANCE', 'DRIVER', 'WAREHOUSE', 'DISPATCH']) {
      assert.equal(salesRowScope({ userId: ME, roles: [r] }), null, `${r} 不该被行级隔离`)
    }
  })

  test('roles[] 为空时回退单 role（与 effectiveRoles 同口径）', () => {
    assert.deepEqual(salesRowScope({ userId: ME, role: 'EXTERNAL_SALES', roles: [] }), { kind: 'own', userId: ME })
    assert.equal(salesRowScope({ userId: ME, role: 'OPERATOR', roles: [] }), null)
  })

  test('无调用者时不隔离（匿名由 middleware 挡在更前面）', () => {
    assert.equal(salesRowScope(null), null)
    assert.equal(salesRowScope({ userId: '' }), null)
  })
})

describe('条件塞进 where 之后不能被丢掉', () => {
  const scope = { kind: 'own' as const, userId: ME }

  test('空 where 也要带上条件（20260802 就是这里失效的）', () => {
    assert.deepEqual(withRowScope({}, scope), { AND: [{ salesUserId: ME }] })
  })

  test('已有 AND 时追加而不是覆盖', () => {
    const w = withRowScope({ AND: [{ isActive: true }] }, scope)
    assert.deepEqual(w.AND, [{ isActive: true }, { salesUserId: ME }])
  })

  test('AND 是单个对象（非数组）时也能合并', () => {
    const w = withRowScope({ AND: { isActive: true } }, scope)
    assert.deepEqual(w.AND, [{ isActive: true }, { salesUserId: ME }])
  })

  test('⛔ 同名查询参数覆盖不掉它 —— ?salesUserId=别人 的绕过必须失效', () => {
    // 模拟 buildOrdersWhere：先按参数写了 where.salesUserId，再合并行级条件
    const w = withRowScope({ salesUserId: OTHER }, scope)
    assert.equal(w.salesUserId, OTHER, '参数本身保留')
    assert.deepEqual(w.AND, [{ salesUserId: ME }], '但 AND 里那一项谁也删不掉')
    // Prisma 语义：两者同时成立 → 查别人的 id 时结果必然为空，看不到任何数据
  })

  test('不隔离时 where 一字不动', () => {
    const w = { status: 'PENDING' }
    assert.equal(withRowScope(w, null), w)
  })
})

describe('单条记录可见性（详情/编辑接口）', () => {
  const scope = { kind: 'own' as const, userId: ME }
  test('自己的可见，别人的不可见', () => {
    assert.equal(isRowVisible({ salesUserId: ME }, scope), true)
    assert.equal(isRowVisible({ salesUserId: OTHER }, scope), false)
  })
  test('⛔ 无归属的记录对被隔离者不可见（默认拒绝，不是默认放行）', () => {
    assert.equal(isRowVisible({ salesUserId: null }, scope), false)
    assert.equal(isRowVisible({}, scope), false)
  })
  test('不隔离时一律可见', () => {
    assert.equal(isRowVisible({ salesUserId: OTHER }, null), true)
    assert.equal(isRowVisible(null, null), true)
  })
})

// ── 数据范围三级（20260807 T8）───────────────────────────────────────────────

describe('dataScope 三级', () => {
  const BOSS_ID = 'u-manager'

  test('token 带 ds 时按它判，不再看角色名字', () => {
    assert.equal(salesRowScope({ userId: ME, ds: 'ALL', roles: ['EXTERNAL_SALES'] }), null,
      'ds=ALL 应当不隔离 —— 范围由角色配置决定，不是按角色名字硬编码')
    assert.deepEqual(salesRowScope({ userId: ME, ds: 'OWN', roles: ['OPERATOR'] }),
      { kind: 'own', userId: ME })
    assert.deepEqual(salesRowScope({ userId: ME, ds: 'TEAM', roles: [] }),
      { kind: 'team', userId: ME })
  })

  test('⛔ 旧 token（无 ds）回退硬编码，行为与改造前一字不差', () => {
    // 少了这条，部署后没重新登录的外部销售会突然看到全量客户
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['EXTERNAL_SALES', 'OPERATOR'] }),
      { kind: 'own', userId: ME })
    assert.equal(salesRowScope({ userId: ME, roles: ['SALES', 'OPERATOR'] }), null)
    assert.deepEqual(salesRowScope({ userId: ME, roles: ['SALES'] }), { kind: 'own', userId: ME })
  })

  test('TEAM 用关系过滤，不额外查库', () => {
    const cond = scopeCondition({ kind: 'team', userId: BOSS_ID })
    assert.deepEqual(cond, {
      OR: [{ salesUserId: BOSS_ID }, { salesUser: { managerId: BOSS_ID } }],
    })
  })

  test('TEAM 的 where 条件同样进 AND，绕不过去', () => {
    const w = withRowScope({ salesUserId: OTHER }, { kind: 'team', userId: BOSS_ID })
    assert.equal(w.salesUserId, OTHER)
    assert.deepEqual(w.AND, [{ OR: [{ salesUserId: BOSS_ID }, { salesUser: { managerId: BOSS_ID } }] }])
  })

  test('TEAM 下：自己的、下属的可见，别人的不可见', () => {
    const scope = { kind: 'team' as const, userId: BOSS_ID }
    assert.equal(isRowVisible({ salesUserId: BOSS_ID }, scope), true, '自己的')
    assert.equal(isRowVisible({ salesUserId: ME, salesUser: { managerId: BOSS_ID } }, scope), true, '下属的')
    assert.equal(isRowVisible({ salesUserId: OTHER, salesUser: { managerId: 'someone-else' } }, scope), false)
    assert.equal(isRowVisible({ salesUserId: OTHER, salesUser: { managerId: null } }, scope), false)
  })

  test('⛔ TEAM 下调用方忘了 select managerId → 保守拒绝，不是放行', () => {
    // 宁可少给，也不能因为字段没取就把别人的数据放出去
    const scope = { kind: 'team' as const, userId: BOSS_ID }
    assert.equal(isRowVisible({ salesUserId: OTHER }, scope), false)
  })
})
