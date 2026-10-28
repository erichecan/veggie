import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPortalOutOfStock, portalOrderBlockers } from '../lib/customer-portal-products'

// 20261028 客户需求：门户里缺货（现存量 <= 0）的商品不能加入购物车、不能下单；
// 取消「在客户门户显示」的商品门户里看不到、也不能下单。卡片与下单闸门共用同一口径。
describe('isPortalOutOfStock', () => {
  test('现存量 <= 0 为缺货，> 0 不是', () => {
    assert.equal(isPortalOutOfStock(0), true)
    assert.equal(isPortalOutOfStock(-3), true)
    assert.equal(isPortalOutOfStock(0.5), false)
    assert.equal(isPortalOutOfStock(12), false)
  })

  test('Prisma Decimal 序列化成的字符串、空值同样按数值判断', () => {
    assert.equal(isPortalOutOfStock('0.000'), true)
    assert.equal(isPortalOutOfStock('4.500'), false)
    assert.equal(isPortalOutOfStock(null), true)
  })
})

describe('portalOrderBlockers', () => {
  const p = (name: string, o: Partial<{ canBeSold: boolean; showInPortal: boolean; qtyOnHand: unknown }> = {}) =>
    ({ name, canBeSold: true, showInPortal: true, qtyOnHand: 10, ...o })

  test('可售、门户可见、有库存 → 不拦', () => {
    assert.deepEqual(portalOrderBlockers([p('Tomato')]), { unavailable: [], outOfStock: [] })
  })

  test('取消「在客户门户显示」或 Can be Sold → 归入 unavailable', () => {
    const r = portalOrderBlockers([p('Hidden', { showInPortal: false }), p('Stopped', { canBeSold: false })])
    assert.deepEqual(r, { unavailable: ['Hidden', 'Stopped'], outOfStock: [] })
  })

  test('现存量 <= 0 → 归入 outOfStock', () => {
    const r = portalOrderBlockers([p('Celery', { qtyOnHand: 0 }), p('Mint', { qtyOnHand: '-2.000' }), p('Leek')])
    assert.deepEqual(r, { unavailable: [], outOfStock: ['Celery', 'Mint'] })
  })

  test('既不可见又缺货的商品只算 unavailable，提示里不重复', () => {
    const r = portalOrderBlockers([p('Both', { showInPortal: false, qtyOnHand: 0 })])
    assert.deepEqual(r, { unavailable: ['Both'], outOfStock: [] })
  })
})
