import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractUnits, lastToken, canonicalize, coverage,
} from '../lib/uom/extract-from-product-name'

/** 全部取自 20260819 生产库快照的真实商品名 */
const REAL_NAMES = [
  'Courgette CASE',
  'Courgette LOOSE',
  'Apple Gala CASE',
  'Apple Gala LOOSE',
  'Baby Potato KG',
  'Aubergine Chinese KG',
  'Cabbage White BAG',
  'Cabbage Red BAG',
  'ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 700g PKT',
  'Shrimp Dumpling Ha Kau 2.5KG PKT',
  '6/8 Black Tiger HOSO 1KG PKT',
  'HT Wei Ji Xian Seasoning  Soy Sauce 750ml Jar',
  'Chilli Sauce 3KG JAR',
  'Sesame Oil 5L Tin',
  'Chilli Oil 20L TIN',
  'Vinegar 500ml Bottle',
  'Soy Sauce 1L BOTTLE',
  'Strawberry 250g PUNNUT',   // 拼写错，生产库真有
  'Blueberry 125g PUNNT',     // 另一种错拼
  'Raspberry 150g PUNNET',
  'Sugar granulated 25Kg  BAG',
  'Rooster 10Kg BAG',
  'Onion 60/80 19.1kg BAG',
  'Free Veg   1KG',           // 末词是 1KG —— 规格不是单位
  'Chilli Green XL 400g',     // 末词 400g —— 规格不是单位
  'Onion Diced+Courgette Mix Cut',  // 末词 Cut —— 普通词
  'price difference',         // 垃圾数据
  'reuse',
]

describe('取末词', () => {
  it('普通名字', () => {
    assert.equal(lastToken('Courgette LOOSE'), 'LOOSE')
  })
  it('⛔ 连续空格不影响（生产库 69 个名字带双空格）', () => {
    assert.equal(lastToken('Sugar granulated 25Kg  BAG'), 'BAG')
    assert.equal(lastToken('ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 700g PKT'), 'PKT')
  })
  it('单个词的名字', () => {
    assert.equal(lastToken('reuse'), 'reuse')
  })
  it('首尾空白', () => {
    assert.equal(lastToken('  Courgette CASE  '), 'CASE')
  })
})

describe('归一化', () => {
  it('大小写统一 —— JAR / Jar 是同一个单位', () => {
    assert.equal(canonicalize('Jar'), 'JAR')
    assert.equal(canonicalize('JAR'), 'JAR')
    assert.equal(canonicalize('kg'), 'KG')
  })
  it('修正已知拼写错误', () => {
    assert.equal(canonicalize('PUNNUT'), 'PUNNET')
    assert.equal(canonicalize('PUNNT'), 'PUNNET')
    assert.equal(canonicalize('PUNNET'), 'PUNNET')
  })
  it('去掉尾部标点', () => {
    assert.equal(canonicalize('CASE.'), 'CASE')
  })
})

describe('提炼', () => {
  const r = extractUnits(REAL_NAMES)
  const names = r.units.map(u => u.name)

  it('高频包装词都收进来了', () => {
    for (const u of ['CASE', 'LOOSE', 'PKT', 'BAG', 'KG', 'JAR', 'TIN', 'BOTTLE']) {
      assert.ok(names.includes(u), `缺少 ${u}`)
    }
  })

  it('大小写变体合并成一个单位，并保留各自写法供人核对', () => {
    const jar = r.units.find(u => u.name === 'JAR')!
    assert.equal(jar.count, 2)
    assert.deepEqual(jar.variants.map(v => v.raw).sort(), ['JAR', 'Jar'])
  })

  it('三种拼法的 PUNNET 合并成一个', () => {
    const p = r.units.find(u => u.name === 'PUNNET')!
    assert.equal(p.count, 3)
    assert.equal(p.variants.length, 3)
  })

  it('⛔ 带数字的末词是规格不是单位 —— 1KG / 400g 不能进单位表', () => {
    assert.ok(!names.includes('1KG'))
    assert.ok(!names.includes('400G'))
    assert.ok(r.skippedNumeric >= 2)
  })

  it('⛔ 普通词不能被当成单位', () => {
    assert.ok(!names.includes('CUT'))
    assert.ok(!names.includes('DIFFERENCE'))
    assert.ok(!names.includes('REUSE'))
  })

  it('被拒的词要回报出来，好让人核对判据是不是太严', () => {
    const rejectedNames = r.rejected.map(x => x.name)
    assert.ok(rejectedNames.includes('CUT') || rejectedNames.includes('DIFFERENCE'))
  })

  it('按出现次数排序，最常用的在最前', () => {
    for (let i = 1; i < r.units.length; i++) {
      assert.ok(r.units[i - 1].count >= r.units[i].count)
    }
  })
})

describe('低频门槛', () => {
  it('白名单里的单位不论多低频都收', () => {
    const r = extractUnits(['Something PALLET'], { minCount: 99 })
    assert.ok(r.units.some(u => u.name === 'PALLET'))
  })

  it('不在白名单又低频的不收', () => {
    const r = extractUnits(['Weird Thing FOOBAR'], { minCount: 3 })
    assert.ok(!r.units.some(u => u.name === 'FOOBAR'))
  })

  it('不在白名单但够频繁的收 —— 客户以后新增的包装词能自动被发现', () => {
    const r = extractUnits(Array(5).fill('Something FOOBAR'), { minCount: 3 })
    assert.ok(r.units.some(u => u.name === 'FOOBAR'))
  })
})

describe('覆盖率', () => {
  it('真实样本的覆盖率应该很高', () => {
    const c = coverage(extractUnits(REAL_NAMES))
    assert.ok(c > 0.7, `覆盖率只有 ${(c * 100).toFixed(1)}%`)
  })
  it('空输入不炸', () => {
    const r = extractUnits([])
    assert.equal(r.units.length, 0)
    assert.equal(coverage(r), 0)
  })
})
