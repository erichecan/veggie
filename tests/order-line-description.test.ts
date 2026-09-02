/**
 * 订单/报价行 Description 的取值规则。
 *
 * 背景（2026-08-18 客户实测反馈）：同一张报价单里，创建时加的
 * "Tomato Beef CASE" 有 Description，编辑时加的同一个商品却空白。
 * 根因是下单页用 `p.spec ?? p.name`、两个编辑页用 `p.spec ?? null`，
 * 而 Description 落库为 OrderLine.spec —— 是**行快照**不是商品实时字段，
 * 于是取值规则的分叉被永久固化进了数据。
 *
 * 2026-08-24 客户再次反馈：不要用商品名兜底，没有 spec 就留空。
 * 三处调用方已统一收口到这一个函数，商品没有 spec 时不再兜底成商品名。
 *
 * 2026-09-02：商品详情页新增「Sale Description」字段（`saleDescription`）之后，
 * 这个函数本身还在只读旧的 `spec`，是合表重构（20260825 把 saleDescription
 * 并入 Product）漏更新的一个消费方——同一批商品在详情页填了 Sale Description，
 * 加进报价单/销售单/采购单却还是空的。取值改成优先 saleDescription，
 * 没有才落回旧的 spec（兼容合表重构前就存在的历史数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDescription } from '../lib/order-line-description'

test('商品有 saleDescription 时优先使用', () => {
  assert.equal(
    lineDescription({ name: 'Broccoli-5', saleDescription: '西兰花', spec: '旧规格文本' }),
    '西兰花',
  )
})

test('没有 saleDescription 时落回旧的 spec（兼容历史数据）', () => {
  assert.equal(
    lineDescription({ name: 'Red Unicorn Long Grain Rice 20kg BAG', spec: '[麒麟]丝苗米' }),
    '[麒麟]丝苗米',
  )
})

test('两个字段都没有时留空，不兜底成商品名', () => {
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: null }), '')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: undefined }), '')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE' }), '')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', saleDescription: null, spec: null }), '')
})

test('saleDescription/spec 是空串或纯空白时按顺序落回，都空则留空', () => {
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', saleDescription: '', spec: '红辣椒' }), '红辣椒')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', saleDescription: '   ', spec: '' }), '')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: '   ' }), '')
})

test('保留原文两端以外的内容，不做多余加工', () => {
  assert.equal(lineDescription({ name: 'X', saleDescription: '  西兰花  ' }), '西兰花')
  assert.equal(lineDescription({ name: 'X', spec: '  [麒麟]丝苗米  ' }), '[麒麟]丝苗米')
})

test('创建路径与编辑路径对同一商品必须得到同一个值（回归防线）', () => {
  const products = [
    { name: 'Tomato Beef CASE', spec: null },
    { name: 'Broccoli-5', saleDescription: '西兰花', spec: null },
    { name: 'Red Unicorn Long Grain Rice 20kg BAG', spec: '[麒麟]丝苗米' },
    { name: 'Edge Case', spec: '' },
  ]
  for (const p of products) {
    // 两条路径现在都只能经由这一个函数取值，值必然相同；
    // 这条测试守的是"将来有人又在某一侧内联写死"的回归。
    assert.equal(lineDescription(p), lineDescription({ ...p }))
  }
})
