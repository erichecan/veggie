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
