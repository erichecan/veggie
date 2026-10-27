import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rankByRelevance } from '../lib/search-rank'

interface P { name: string; ref?: string | null }
const get = (p: P) => [p.name, p.ref]

describe('⛔ 商品名里的连续空格不能让商品从搜索里消失', () => {
  // 客户 20260819 实报：搜 `ICE Black Tiger Shrimp` 显示"没有匹配商品"。
  // 库里那条 CHOICE 后面是**两个空格**，生产库共 69 个商品名有这毛病。
  const items: P[] = [
    { name: 'ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 700g PKT' },
    { name: 'Courgette LOOSE' },
  ]

  it('用户按看到的样子输入单空格，也要能搜到', () => {
    const r = rankByRelevance(items, 'CHOICE Black Tiger', get)
    assert.equal(r.length, 1)
    assert.match(r[0].name, /Black Tiger/)
  })

  it('查询里多打了空格同样不影响', () => {
    const r = rankByRelevance(items, '  Courgette   LOOSE  ', get)
    assert.equal(r.length, 1)
    assert.equal(r[0].name, 'Courgette LOOSE')
  })

  it('归一后仍算「完全相等」，排在最前', () => {
    const r = rankByRelevance(
      [{ name: 'Courgette LOOSE CASE' }, { name: 'Courgette  LOOSE' }],
      'Courgette LOOSE',
      get,
    )
    assert.equal(r[0].name, 'Courgette  LOOSE')
  })
})

describe('相关性分层不变', () => {
  const items: P[] = [
    { name: 'Baby Potato KG' },
    { name: 'Potato Baby' },
    { name: 'Sweet Potato' },
    { name: 'Red Onion' },
  ]

  it('整串前缀优先于中间包含', () => {
    const r = rankByRelevance(items, 'Potato', get)
    assert.equal(r[0].name, 'Potato Baby')
    assert.equal(r.length, 3)
  })

  it('不匹配的被过滤掉', () => {
    assert.equal(rankByRelevance(items, 'zzz', get).length, 0)
  })

  it('空查询原样返回', () => {
    assert.equal(rankByRelevance(items, '   ', get).length, items.length)
  })

  it('内部编号也参与匹配', () => {
    const r = rankByRelevance([{ name: 'Baby Potato KG', ref: 'BP-001' }], 'BP-001', get)
    assert.equal(r.length, 1)
  })
})

describe('第 4 层：多词乱序全部命中（20261021 加）', () => {
  it('词序和文本不一致时仍能搜到，且排在前三层之后', () => {
    const items: P[] = [
      { name: 'Prawn Tiger 31/40' },
      { name: 'Tiger Prawn Cooked' },
    ]
    const r = rankByRelevance(items, 'tiger prawn', get)
    assert.equal(r.length, 2)
    // 整串前缀命中的排第一层，乱序命中的排在它后面
    assert.equal(r[0].name, 'Tiger Prawn Cooked')
    assert.equal(r[1].name, 'Prawn Tiger 31/40')
  })

  it('单个词不触发第 4 层（避免跟第 2/3 层重复判定、拖慢单词查询）', () => {
    const r = rankByRelevance([{ name: 'Prawn Tiger 31/40' }], 'prawn', get)
    assert.equal(r.length, 1)
  })

  it('乱序词里有一个词文本里完全没有，仍然搜不到', () => {
    const r = rankByRelevance([{ name: 'Prawn Tiger 31/40' }], 'tiger salmon', get)
    assert.equal(r.length, 0)
  })
})
