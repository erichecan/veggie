/**
 * 单价来源徽章（台账 X1）
 *
 * 手动改价这一档是本次新增的。它最重要的性质不是"有个红标签"，而是
 * **hover 能看到当时的规则价** —— 事后翻单时，"这行 €48.80 是人定的"
 * 与"当时价格表说 €35.00"必须同时在场，否则查不出偏离了多少。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatPriceSourceBadge } from '../lib/price-source'

describe('单价来源徽章', () => {
  test('手动改价是已知类型，不能掉进「历史订单未记录」那一档', () => {
    const b = formatPriceSourceBadge({ priceSourceType: 'MANUAL' }, false)
    assert.notEqual(b.label, '—', '落成「—」的话，手动改价在纸面上与历史脏数据长得一样')
    assert.equal(b.label, 'Manual')
  })

  test('hover 提示带出当时的价格表价', () => {
    const b = formatPriceSourceBadge(
      { priceSourceType: 'MANUAL', priceSourceDetail: '手动改价（价格表价 €35.00）' }, false,
    )
    assert.match(b.title, /35\.00/)
  })

  test('没有明细时也要给出可读文案，不能是空串', () => {
    const zh = formatPriceSourceBadge({ priceSourceType: 'MANUAL', priceSourceDetail: null }, false)
    const en = formatPriceSourceBadge({ priceSourceType: 'MANUAL', priceSourceDetail: null }, true)
    assert.ok(zh.title.length > 0 && en.title.length > 0)
    assert.notEqual(zh.title, en.title, '中英界面应给各自语言的文案')
  })

  test('原有四档不受影响', () => {
    assert.equal(formatPriceSourceBadge({ priceSourceType: 'PRICELIST' }, false).label, 'Plist')
    assert.equal(formatPriceSourceBadge({ priceSourceType: 'LAST' }, false).label, 'Last')
    assert.equal(formatPriceSourceBadge({ priceSourceType: 'DEFAULT' }, false).label, 'Default')
    assert.equal(formatPriceSourceBadge({ priceSourceType: 'SPECIAL' }, false).label, 'Special')
  })

  test('历史订单（无来源字段）仍显示「—」', () => {
    assert.equal(formatPriceSourceBadge({ priceSourceType: null }, false).label, '—')
    assert.equal(formatPriceSourceBadge({ priceSourceType: 'BOGUS' }, false).label, '—')
  })
})
