import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchOne, matchStats, tokenize, normalizeName } from '../lib/purchase/product-match'

/** 取自 20260819 生产库快照的真实商品名（含那批历史测试垃圾） */
const PRODUCTS = [
  { id: 'p-vest', name: 'vest' },
  { id: 'p-osp', name: 'osp' },
  { id: 'p-zero', name: '0' },
  { id: 'p-reuse', name: 'reuse' },
  { id: 'p-courg-case', name: 'Courgette CASE' },
  { id: 'p-courg-loose', name: 'Courgette LOOSE' },
  { id: 'p-courg-slice', name: 'Courgette Slice KG' },
  { id: 'p-onion-mix', name: 'Onion Diced+Courgette Mix Cut' },
  { id: 'p-tiger-pkt', name: 'ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 700g PKT' },
  { id: 'p-tiger-case', name: 'ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 10*700g CASE' },
  { id: 'p-apple-loose', name: 'Apple Gala LOOSE' },
  { id: 'p-apple-case', name: 'Apple Gala CASE' },
  { id: 'p-babypot', name: 'Baby Potato KG', internalRef: 'BP-001' },
]

describe('⛔ 短名商品不再是万能匹配器（旧实现的头号 bug）', () => {
  it('Harvest Beans 不能被匹配成 vest', () => {
    const r = matchOne('Harvest Beans', PRODUCTS)
    assert.notEqual(r.matchedProductName, 'vest')
    assert.equal(r.confidence, 'none')
  })

  it('任何含 0 的品名都不能被匹配成商品「0」', () => {
    const r = matchOne('Potato 10kg', PRODUCTS)
    assert.notEqual(r.matchedProductId, 'p-zero')
  })

  it('Reusable Crate Large 不能被匹配成 reuse', () => {
    const r = matchOne('Reusable Crate Large', PRODUCTS)
    assert.notEqual(r.matchedProductName, 'reuse')
  })

  it('反过来：商品就叫 vest 时，查询 vest 仍应精确命中', () => {
    const r = matchOne('vest', PRODUCTS)
    assert.equal(r.matchedProductId, 'p-vest')
    assert.equal(r.confidence, 'exact')
  })
})

describe('歧义必须交给人，不能闷头取第一个', () => {
  it('Courgette 命中多个 → 不自动选，标 ambiguous 并给候选', () => {
    const r = matchOne('Courgette', PRODUCTS)
    assert.equal(r.matchedProductId, null)
    assert.equal(r.ambiguous, true)
    assert.equal(r.confidence, 'none')
    const names = r.candidates.map(c => c.name)
    assert.ok(names.includes('Courgette CASE'))
    assert.ok(names.includes('Courgette LOOSE'))
  })

  it('带上单位后缀就能唯一定位', () => {
    const r = matchOne('Courgette LOOSE', PRODUCTS)
    assert.equal(r.matchedProductId, 'p-courg-loose')
    assert.equal(r.confidence, 'exact')
  })

  it('候选最多给 5 个', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Tomato Type${i}` }))
    const r = matchOne('Tomato', many)
    assert.ok(r.candidates.length <= 5)
  })
})

describe('商品名里的连续空格不能挡住匹配（生产库 69 个）', () => {
  it('单空格查询能命中双空格商品名', () => {
    const r = matchOne('ASIAN CHOICE Black Tiger Shrimp HOSO 31/40 700g PKT', PRODUCTS)
    assert.equal(r.matchedProductId, 'p-tiger-pkt')
    assert.equal(r.confidence, 'exact')
  })

  it('normalizeName 把连续空白压成一个', () => {
    assert.equal(normalizeName('  ASIAN   CHOICE\tBlack  '), 'asian choice black')
  })
})

describe('单位后缀不参与打分，但仍能区分同基名商品', () => {
  it('只给基名 + 单位时精确命中对应那条', () => {
    assert.equal(matchOne('Apple Gala CASE', PRODUCTS).matchedProductId, 'p-apple-case')
    assert.equal(matchOne('Apple Gala LOOSE', PRODUCTS).matchedProductId, 'p-apple-loose')
  })

  it('商品名整个就是单位词时不会被切空', () => {
    const r = matchOne('KG', [{ id: 'x', name: 'KG' }])
    assert.equal(r.matchedProductId, 'x')
  })
})

describe('内部编号优先于名字', () => {
  it('编号精确命中直接判 exact', () => {
    const r = matchOne('BP-001', PRODUCTS)
    assert.equal(r.matchedProductId, 'p-babypot')
    assert.equal(r.confidence, 'exact')
  })
})

describe('同名商品（生产库 70 组）必须判为需人工处理', () => {
  it('两个同名商品 → 不选，标 ambiguous', () => {
    const dup = [{ id: 'a', name: 'Tomato' }, { id: 'b', name: 'Tomato' }]
    const r = matchOne('Tomato', dup)
    assert.equal(r.matchedProductId, null)
    assert.equal(r.ambiguous, true)
    assert.equal(r.candidates.length, 2)
  })
})

describe('边界', () => {
  it('空字符串 → none', () => {
    assert.equal(matchOne('', PRODUCTS).confidence, 'none')
    assert.equal(matchOne('   ', PRODUCTS).confidence, 'none')
  })

  it('空商品库 → none 且不抛错', () => {
    assert.equal(matchOne('Anything', []).confidence, 'none')
  })

  it('纯符号查询 → none', () => {
    assert.equal(matchOne('***', PRODUCTS).confidence, 'none')
  })

  it('tokenize 保留中文', () => {
    assert.deepEqual(tokenize('角瓜 Courgette'), ['角瓜', 'courgette'])
  })
})

describe('单据上的「英文名 + 中文别名」并排（客户单据的真实形态）', () => {
  it('中文别名对不上时不该拖垮整行 —— Courgette LOOSE 角瓜 仍应命中', () => {
    const r = matchOne('Courgette LOOSE 角瓜', PRODUCTS)
    assert.equal(r.matchedProductId, 'p-courg-loose')
  })

  it('⛔ 放松别名不等于放松实质匹配：Harvest Beans 依然配不上 vest', () => {
    const r = matchOne('Harvest Beans 四季豆', PRODUCTS)
    assert.equal(r.confidence, 'none')
    assert.notEqual(r.matchedProductName, 'vest')
  })

  it('纯中文查询命中纯中文商品名', () => {
    const zh = [{ id: 'z1', name: '角瓜 散装' }]
    assert.equal(matchOne('角瓜', zh).matchedProductId, 'z1')
  })
})

describe('matchStats 统计', () => {
  it('按置信度分桶', () => {
    const lines = [
      matchOne('vest', PRODUCTS),          // exact
      matchOne('Courgette', PRODUCTS),     // none + ambiguous
      matchOne('Harvest Beans', PRODUCTS), // none
    ]
    const s = matchStats(lines)
    assert.equal(s.total, 3)
    assert.equal(s.exact, 1)
    assert.equal(s.none, 2)
    assert.equal(s.ambiguous, 1)
  })
})
