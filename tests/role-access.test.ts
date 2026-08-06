/**
 * 外部角色边界。
 *
 * 这层判定一旦写松，表现是「外部客户能看到全公司数据」且不报任何错 ——
 * 2026-08-06 审计前就是这个状态，持续了很久没人发现。所以把边界逐条钉死。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canExternalRoleAccessApi, canExternalRoleAccessPage, isExternalRole,
  EXTERNAL_ROLE_API_ALLOWLIST,
} from '../lib/role-access'

describe('isExternalRole', () => {
  test('RESTAURANT 是受限角色', () => {
    assert.equal(isExternalRole(['RESTAURANT']), 'RESTAURANT')
  })
  test('内部角色不受这一层限制', () => {
    for (const r of ['OPERATOR', 'BOSS', 'FINANCE', 'DRIVER', 'SALES', 'WAREHOUSE', 'DISPATCH']) {
      assert.equal(isExternalRole([r]), null, `${r} 不该被当成外部角色`)
    }
  })
  test('多角色里只要含 RESTAURANT 就按受限处理', () => {
    assert.equal(isExternalRole(['OPERATOR', 'RESTAURANT']), 'RESTAURANT')
  })
})

describe('RESTAURANT 的 API 边界', () => {
  test('✅ 客户门户放行', () => {
    for (const p of [
      '/api/customer-portal/products',
      '/api/customer-portal/orders',
      '/api/customer-portal/frequently-ordered',
    ]) {
      assert.ok(canExternalRoleAccessApi('RESTAURANT', p), `${p} 应放行`)
    }
  })

  test('✅ 登录与自己的通知放行', () => {
    assert.ok(canExternalRoleAccessApi('RESTAURANT', '/api/auth/login'))
    assert.ok(canExternalRoleAccessApi('RESTAURANT', '/api/auth/change-password'))
    assert.ok(canExternalRoleAccessApi('RESTAURANT', '/api/notifications'))
  })

  test('⛔ 审计实测泄露过的那些接口，必须全部拒绝', () => {
    // 这份清单直接来自 2026-08-06 的实测结果，逐条锁死
    const leaked = [
      '/api/customers',           // 曾泄露 1,596 家全量名册（含税号/信用额度/提成率）
      '/api/orders',              // 曾泄露 500 张订单，499 张是别家的
      '/api/invoices',
      '/api/purchase-orders',     // 采购成本
      '/api/suppliers',
      '/api/stock-moves',
      '/api/action-logs',
      '/api/driver-slots',
      '/api/pricelists',          // 曾被真的 POST 成功
      '/api/products',
      '/api/users',
      '/api/analytics/margin',
      '/api/backups',
    ]
    for (const p of leaked) {
      assert.equal(canExternalRoleAccessApi('RESTAURANT', p), false, `${p} 必须拒绝`)
    }
  })

  test('⛔ 前缀匹配必须按路径段，不能被相似前缀骗过', () => {
    // /api/auth 放行，但 /api/authorize-anything 不该跟着放行
    assert.equal(canExternalRoleAccessApi('RESTAURANT', '/api/authorize-everything'), false)
    // /api/customer-portal 放行，但 /api/customers 不该
    assert.equal(canExternalRoleAccessApi('RESTAURANT', '/api/customers'), false)
    assert.equal(canExternalRoleAccessApi('RESTAURANT', '/api/customer-portal-admin'), false)
  })

  test('内部角色不受影响', () => {
    assert.ok(canExternalRoleAccessApi('OPERATOR', '/api/customers'))
    assert.ok(canExternalRoleAccessApi('BOSS', '/api/analytics/margin'))
  })
})

describe('RESTAURANT 的页面边界', () => {
  test('✅ 客户门户与登录页放行', () => {
    assert.ok(canExternalRoleAccessPage('RESTAURANT', '/customer-portal'))
    assert.ok(canExternalRoleAccessPage('RESTAURANT', '/customer-portal/orders'))
    assert.ok(canExternalRoleAccessPage('RESTAURANT', '/enter'))
    assert.ok(canExternalRoleAccessPage('RESTAURANT', '/'))
  })

  test('⛔ 运营后台一律拒绝 —— 用户明确要求「不能登录到运营后台」', () => {
    for (const p of [
      '/classic/operator', '/classic/operator/customers', '/classic/operator/orders',
      '/classic/boss', '/classic/finance', '/classic/warehouse', '/classic/driver',
      '/classic/accounting', '/classic/restaurant',
    ]) {
      assert.equal(canExternalRoleAccessPage('RESTAURANT', p), false, `${p} 必须拒绝`)
    }
  })
})

describe('白名单本身的约束', () => {
  test('⛔ 白名单里不许出现能读到别家数据的接口', () => {
    const forbidden = ['/api/customers', '/api/orders', '/api/invoices', '/api/products', '/api/analytics']
    for (const [role, list] of Object.entries(EXTERNAL_ROLE_API_ALLOWLIST)) {
      for (const entry of list) {
        assert.ok(
          !forbidden.includes(entry),
          `${role} 的白名单里出现了 ${entry} —— 这会让外部角色读到全量业务数据`,
        )
      }
    }
  })
})
