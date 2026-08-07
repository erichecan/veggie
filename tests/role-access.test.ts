/**
 * 收窄型角色的边界。
 *
 * 这层判定一旦写松，表现是「某个岗位能看到全公司数据」且不报任何错 ——
 * 2026-08-06 审计前就是这个状态，持续了很久没人发现。所以把边界逐条钉死。
 *
 * 两个方向都要测：
 *   ⛔ 不该给的必须拒（漏了 = 越权）
 *   ✅ 该给的必须放（漏了 = 误伤，某个岗位的页面突然全 403）
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canRolesAccessApi, canRolesAccessPage, apiScopeFor, homeFor, matchesPattern,
  ROLE_API_SCOPE,
} from '../lib/role-access'

const allow = (roles: string[], path: string, method = 'GET') =>
  canRolesAccessApi(roles, path, method)

describe('段级匹配（不是前缀匹配）', () => {
  test('* 恰好一段', () => {
    assert.ok(matchesPattern('/api/trips/*', '/api/trips/abc'))
    assert.equal(matchesPattern('/api/trips/*', '/api/trips/abc/settlement'), false)
    assert.equal(matchesPattern('/api/trips/*', '/api/trips'), false)
  })
  test('** 任意深度且含零段', () => {
    assert.ok(matchesPattern('/api/customer-portal/**', '/api/customer-portal'))
    assert.ok(matchesPattern('/api/customer-portal/**', '/api/customer-portal/orders/x1'))
  })
  test('⛔ 不能被相似前缀骗过 —— 这正是 20260802 泄露的成因', () => {
    assert.equal(matchesPattern('/api/auth/**', '/api/authorize-everything'), false)
    assert.equal(matchesPattern('/api/customer-portal/**', '/api/customers'), false)
    assert.equal(matchesPattern('/api/trips', '/api/trips-archive'), false)
  })
})

describe('谁受这一层收窄', () => {
  test('OPERATOR / BOSS 不受收窄', () => {
    assert.equal(apiScopeFor(['OPERATOR']), null)
    assert.equal(apiScopeFor(['BOSS']), null)
    assert.ok(allow(['OPERATOR'], '/api/customers', 'DELETE'))
  })
  test('OPERATOR 兼任某岗位时按 OPERATOR 算（不收窄）', () => {
    assert.equal(apiScopeFor(['OPERATOR', 'SALES']), null)
  })
  test('⛔ 但 RESTAURANT 是外部身份，兼任内部角色也照挡', () => {
    assert.equal(allow(['OPERATOR', 'RESTAURANT'], '/api/customers'), false)
    assert.equal(allow(['RESTAURANT', 'BOSS'], '/api/analytics/margin'), false)
  })
  test('一人多岗（非外部）时能力取并集', () => {
    assert.ok(allow(['DRIVER', 'SORTER'], '/api/waves'))
    assert.ok(allow(['DRIVER', 'SORTER'], '/api/trips'))
  })
  test('角色为空时不收窄（老 token 兼容，鉴权仍由 middleware 兜底）', () => {
    assert.equal(apiScopeFor([]), null)
  })
})

describe('RESTAURANT —— 审计实测泄露过的接口必须全拒', () => {
  test('✅ 客户门户与登录放行', () => {
    for (const p of [
      '/api/customer-portal/products',
      '/api/customer-portal/orders',
      '/api/customer-portal/frequently-ordered',
      '/api/auth/change-password',
      '/api/notifications',
    ]) assert.ok(allow(['RESTAURANT'], p), `${p} 应放行`)
    assert.ok(allow(['RESTAURANT'], '/api/customer-portal/orders', 'POST'))
  })

  test('⛔ 这份清单直接来自 2026-08-06 的实测结果，逐条锁死', () => {
    const leaked = [
      '/api/customers',           // 曾泄露 1,596 家全量名册（含税号/信用额度/提成率）
      '/api/orders',              // 曾泄露 500 张订单，499 张是别家的
      '/api/invoices', '/api/purchase-orders', '/api/suppliers',
      '/api/stock-moves', '/api/action-logs', '/api/driver-slots',
      '/api/pricelists',          // 曾被真的 POST 成功
      '/api/products', '/api/users', '/api/analytics/margin', '/api/backups',
    ]
    for (const p of leaked) {
      assert.equal(allow(['RESTAURANT'], p), false, `${p} 必须拒绝`)
      assert.equal(allow(['RESTAURANT'], p, 'POST'), false, `POST ${p} 必须拒绝`)
    }
  })
})

describe('DRIVER —— 生产 21 人，唯一有真实用户的收窄角色', () => {
  test('✅ 司机端页面实际调用的 5 个接口全放行（漏一个司机就干不了活）', () => {
    assert.ok(allow(['DRIVER'], '/api/trips'))
    assert.ok(allow(['DRIVER'], '/api/trips/t1'))
    assert.ok(allow(['DRIVER'], '/api/trips/t1', 'PUT'))          // 签收/退货/完成站点
    assert.ok(allow(['DRIVER'], '/api/trips/t1/settlement'))
    assert.ok(allow(['DRIVER'], '/api/trips/t1/settlement', 'POST'))  // 交账提交
    assert.ok(allow(['DRIVER'], '/api/customers/coordinates'))     // 地图打点
  })
  test('⛔ 建行程/删行程是调度的事', () => {
    assert.equal(allow(['DRIVER'], '/api/trips', 'POST'), false)
    assert.equal(allow(['DRIVER'], '/api/trips/t1', 'DELETE'), false)
  })
  test('⛔ 签收更正是主管权限，司机不能改自己收的签名', () => {
    assert.equal(allow(['DRIVER'], '/api/trips/t1/signature-correction', 'POST'), false)
  })
  test('⛔ 客户名册、订单、商品、成本一律不可见', () => {
    for (const p of ['/api/customers', '/api/orders', '/api/products',
      '/api/purchase-orders', '/api/invoices', '/api/analytics/margin', '/api/users']) {
      assert.equal(allow(['DRIVER'], p), false, `${p} 必须拒绝`)
    }
  })
})

describe('SORTER / WAREHOUSE', () => {
  test('✅ 分拣：波次可读可推进、订单只读', () => {
    assert.ok(allow(['SORTER'], '/api/waves'))
    assert.ok(allow(['SORTER'], '/api/waves/w1', 'PUT'))
    assert.ok(allow(['SORTER'], '/api/waves/w1/pick-sheet'))
    assert.ok(allow(['SORTER'], '/api/orders'))
  })
  test('⛔ 分拣不能删波次、不能碰订单写、不能碰钱', () => {
    assert.equal(allow(['SORTER'], '/api/waves/w1', 'DELETE'), false)
    assert.equal(allow(['SORTER'], '/api/orders/o1', 'PUT'), false)
    assert.equal(allow(['SORTER'], '/api/invoices'), false)
  })
  test('✅ 仓库：库存/盘点/收货可写，商品只读', () => {
    assert.ok(allow(['WAREHOUSE'], '/api/stock-moves', 'POST'))
    assert.ok(allow(['WAREHOUSE'], '/api/stock-takes', 'POST'))
    assert.ok(allow(['WAREHOUSE'], '/api/stock-takes/s1', 'PATCH'))
    assert.ok(allow(['WAREHOUSE'], '/api/lots/expiring'))
    assert.ok(allow(['WAREHOUSE'], '/api/products'))
  })
  test('⛔ 仓库不能改商品价格、不能看客户与财务', () => {
    assert.equal(allow(['WAREHOUSE'], '/api/products/p1', 'PUT'), false)
    assert.equal(allow(['WAREHOUSE'], '/api/pricelists'), false)
    assert.equal(allow(['WAREHOUSE'], '/api/customers'), false)
    assert.equal(allow(['WAREHOUSE'], '/api/invoices'), false)
  })
})

describe('FINANCE / DISPATCH', () => {
  test('✅ 财务：钱那一摊可写，主数据只读', () => {
    assert.ok(allow(['FINANCE'], '/api/invoices/i1', 'PUT'))
    assert.ok(allow(['FINANCE'], '/api/statements', 'POST'))
    assert.ok(allow(['FINANCE'], '/api/trips/t1/settlement', 'PUT'))   // 确认交账
    assert.ok(allow(['FINANCE'], '/api/customers'))
    assert.ok(allow(['FINANCE'], '/api/analytics/ar-aging'))
  })
  test('⛔ 财务不能改客户资料、不能改商品与价格、不能碰备份', () => {
    assert.equal(allow(['FINANCE'], '/api/customers/c1', 'PUT'), false)
    assert.equal(allow(['FINANCE'], '/api/products/p1', 'PUT'), false)
    assert.equal(allow(['FINANCE'], '/api/pricelists', 'POST'), false)
    assert.equal(allow(['FINANCE'], '/api/backups'), false)
  })
  test('✅ 调度：波次行程可排，订单只能改派', () => {
    assert.ok(allow(['DISPATCH'], '/api/waves', 'POST'))
    assert.ok(allow(['DISPATCH'], '/api/trips', 'POST'))
    assert.ok(allow(['DISPATCH'], '/api/orders/o1/batch', 'PUT'))
    assert.ok(allow(['DISPATCH'], '/api/batch-analysis'))
  })
  test('⛔ 调度不能改订单内容、不能碰钱', () => {
    assert.equal(allow(['DISPATCH'], '/api/orders/o1', 'PUT'), false)
    assert.equal(allow(['DISPATCH'], '/api/orders/o1', 'DELETE'), false)
    assert.equal(allow(['DISPATCH'], '/api/invoices'), false)
    assert.equal(allow(['DISPATCH'], '/api/analytics/margin'), false)
  })
})

describe('SALES vs EXTERNAL_SALES —— 决策 2 的边界差异', () => {
  test('✅ 两者都能下单、看客户与商品', () => {
    for (const r of ['SALES', 'EXTERNAL_SALES']) {
      assert.ok(allow([r], '/api/orders', 'POST'), `${r} 应能下单`)
      assert.ok(allow([r], '/api/customers'), `${r} 应能看客户`)
      assert.ok(allow([r], '/api/products'), `${r} 应能看商品`)
    }
  })
  test('⛔ 外部销售：不给发票、不给价格表、不能改客户、不给花名册', () => {
    assert.equal(allow(['EXTERNAL_SALES'], '/api/invoices'), false)
    assert.equal(allow(['EXTERNAL_SALES'], '/api/pricelists'), false)
    assert.equal(allow(['EXTERNAL_SALES'], '/api/customers/c1', 'PUT'), false)
    assert.equal(allow(['EXTERNAL_SALES'], '/api/users'), false)
  })
  test('✅ 正式销售有这四样', () => {
    assert.ok(allow(['SALES'], '/api/invoices'))
    assert.ok(allow(['SALES'], '/api/pricelists'))
    assert.ok(allow(['SALES'], '/api/customers/c1', 'PUT'))
    assert.ok(allow(['SALES'], '/api/users'))
  })
  test('⛔ 两者都不能删订单、不能碰采购与库存与分析', () => {
    for (const r of ['SALES', 'EXTERNAL_SALES']) {
      assert.equal(allow([r], '/api/orders/o1', 'DELETE'), false, `${r} 不该能删订单`)
      assert.equal(allow([r], '/api/purchase-orders'), false)
      assert.equal(allow([r], '/api/stock-moves', 'POST'), false)
      assert.equal(allow([r], '/api/analytics/margin'), false)
      assert.equal(allow([r], '/api/backups'), false)
    }
  })
})

describe('PICKER / OTHER —— 只给公共部分', () => {
  test('⛔ 除登录与通知外一律拒绝', () => {
    for (const r of ['PICKER', 'OTHER']) {
      assert.ok(allow([r], '/api/auth/change-password', 'POST'))
      assert.ok(allow([r], '/api/notifications'))
      for (const p of ['/api/orders', '/api/waves', '/api/customers', '/api/products']) {
        assert.equal(allow([r], p), false, `${r} 不该能访问 ${p}`)
      }
    }
  })
})

describe('页面边界', () => {
  test('✅ 各角色进得去自己那块', () => {
    assert.ok(canRolesAccessPage(['RESTAURANT'], '/customer-portal'))
    assert.ok(canRolesAccessPage(['DRIVER'], '/classic/driver/trip/t1'))
    assert.ok(canRolesAccessPage(['SORTER'], '/classic/sorter'))
    assert.ok(canRolesAccessPage(['FINANCE'], '/classic/accounting'))
  })
  test('⛔ 进不去别人那块', () => {
    assert.equal(canRolesAccessPage(['DRIVER'], '/classic/operator/customers'), false)
    assert.equal(canRolesAccessPage(['DRIVER'], '/classic/boss'), false)
    assert.equal(canRolesAccessPage(['WAREHOUSE'], '/classic/finance'), false)
    assert.equal(canRolesAccessPage(['RESTAURANT'], '/classic/restaurant'), false)
    // /classic/print 的 layout 没有任何角色判定，只能靠这一层挡
    assert.equal(canRolesAccessPage(['DRIVER'], '/classic/print'), false)
  })
  test('OPERATOR / BOSS 不受页面收窄', () => {
    assert.ok(canRolesAccessPage(['OPERATOR'], '/classic/boss'))
    assert.ok(canRolesAccessPage(['BOSS'], '/classic/warehouse'))
  })
  test('落点：被拦下后回自己的主页而不是死循环', () => {
    assert.equal(homeFor(['DRIVER']), '/classic/driver')
    assert.equal(homeFor(['RESTAURANT']), '/customer-portal')
    assert.equal(homeFor(['OPERATOR', 'RESTAURANT']), '/customer-portal')
    assert.equal(homeFor(['PICKER']), '/enter')
  })
})

describe('规则表本身的约束', () => {
  test('⛔ 收窄角色里除财务外，谁都不该有分析中心与备份', () => {
    for (const [role, scopes] of Object.entries(ROLE_API_SCOPE)) {
      for (const s of scopes) {
        assert.ok(!s.pattern.startsWith('/api/backups'),
          `${role} 的规则里出现了备份接口 —— 备份含全库数据`)
        if (role !== 'FINANCE') {
          assert.ok(!s.pattern.startsWith('/api/analytics'),
            `${role} 的规则里出现了分析中心 —— 那是全公司经营数据`)
        }
      }
    }
  })
  test('⛔ 任何角色都不能有 /api/gdpr 与 /api/users 的写', () => {
    for (const role of Object.keys(ROLE_API_SCOPE)) {
      assert.equal(canRolesAccessApi([role], '/api/gdpr/export', 'POST'), false, `${role} 不该能调 GDPR 导出`)
      assert.equal(canRolesAccessApi([role], '/api/users', 'POST'), false, `${role} 不该能建用户`)
      assert.equal(canRolesAccessApi([role], '/api/users/u1', 'DELETE'), false, `${role} 不该能删用户`)
    }
  })
})
