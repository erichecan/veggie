/**
 * 新建报价单/订单页：手改过的单价不被自动重算覆盖（20261022 客户反馈：Carrot 手改成 16.5，
 * 再加别的商品，价格变回 3）。根因是「lastPrices 变化 → 全部行按定价引擎重算」的 effect
 * 不区分手改过的行；加一个新商品就会拉它的最近成交价、更新 lastPrices，连带覆盖所有行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('app/[locale]/classic/operator/place-order/page.tsx', 'utf-8')

test('改单价输入框会把这一行标成手动改价', () => {
  assert.match(src, /unitPrice: parseFloat\(e\.target\.value\) \|\| 0, priceManual: true, priceLabel: 'Manual'/)
})

test('lastPrices / 价格表 / 价格口径变化的整单重算跳过手改过的行', () => {
  const effect = src.slice(src.indexOf('}, [priceType, pricelistId, customerId, lastPrices])') - 1500, src.indexOf('}, [priceType, pricelistId, customerId, lastPrices])'))
  assert.match(effect, /if \(!l\.productId \|\| l\.priceManual\) return l/)
})

test('改数量不重算手改过的价；换商品、换客户才清掉手改标记', () => {
  assert.match(src, /if \(effectiveCustomer && line\.productId && !line\.priceManual\)/)
  assert.match(src, /priceManual: false,\s*\n\s*taxRate:/)
  assert.match(src, /setLines\(prev => prev\.some\(l => l\.priceManual\)/)
})
