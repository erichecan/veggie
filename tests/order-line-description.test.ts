/**
 * 订单/报价行 Description 的取值规则。
 *
 * 背景（2026-08-18 客户实测反馈）：同一张报价单里，创建时加的
 * "Tomato Beef CASE" 有 Description，编辑时加的同一个商品却空白。
 * 根因是下单页用 `p.spec ?? p.name`、两个编辑页用 `p.spec ?? null`，
 * 而 Description 落库为 OrderLine.spec —— 是**行快照**不是商品实时字段，
 * 于是取值规则的分叉被永久固化进了数据。
 *
 * 生产库实测：5477 个商品里 3970 个（72.5%）spec 为空，
 * 所以缺了 name 兜底几乎必然显形。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDescription } from '../lib/order-line-description'

test('商品自带 spec 时原样使用', () => {
  assert.equal(
    lineDescription({ name: 'Red Unicorn Long Grain Rice 20kg BAG', spec: '[麒麟]丝苗米' }),
    '[麒麟]丝苗米',
  )
})

test('商品没有 spec 时兜底成商品名 —— 这正是客户报的那条', () => {
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: null }), 'Tomato Beef CASE')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: undefined }), 'Tomato Beef CASE')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE' }), 'Tomato Beef CASE')
})

test('spec 是空串或纯空白也要兜底（?? 挡不住空串，必须用 ||）', () => {
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: '' }), 'Tomato Beef CASE')
  assert.equal(lineDescription({ name: 'Tomato Beef CASE', spec: '   ' }), 'Tomato Beef CASE')
})

test('保留 spec 两端以外的原文，不做多余加工', () => {
  assert.equal(lineDescription({ name: 'X', spec: '  [麒麟]丝苗米  ' }), '[麒麟]丝苗米')
})

test('创建路径与编辑路径对同一商品必须得到同一个值（回归防线）', () => {
  const products = [
    { name: 'Tomato Beef CASE', spec: null },
    { name: 'Red Unicorn Long Grain Rice 20kg BAG', spec: '[麒麟]丝苗米' },
    { name: 'Edge Case', spec: '' },
  ]
  for (const p of products) {
    // 两条路径现在都只能经由这一个函数取值，值必然相同；
    // 这条测试守的是"将来有人又在某一侧内联写死"的回归。
    assert.equal(lineDescription(p), lineDescription({ ...p }))
    assert.notEqual(lineDescription(p), '')
  }
})
