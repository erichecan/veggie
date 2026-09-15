/**
 * 打印行排序的行为锁。
 *
 * 规则来自生产实测（见 docs/20260818-print-sequence-and-density-tasks.md §1）：
 * 18.4% 的订单行拿不到商品 sequence，光按 sequence 排的话这些行的顺序仍然由
 * 数据库返回顺序决定 —— 也就是仍然随机。所以 NULL 必须有确定的去处，
 * 且 NULL 之间要有稳定的次级顺序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortLinesBySequence, sortLinesByUomSequence } from '../lib/print/line-sort'

const names = <T extends { productName: string }>(rows: readonly T[]) => rows.map(r => r.productName)

test('有 sequence 的按升序', () => {
  const out = sortLinesBySequence([
    { productName: 'C', productSequence: 300 },
    { productName: 'A', productSequence: 100 },
    { productName: 'B', productSequence: 200 },
  ])
  assert.deepEqual(names(out), ['A', 'B', 'C'])
})

test('没有 sequence 的排在最后，而不是当成 0 排到最前', () => {
  const out = sortLinesBySequence([
    { productName: '没序号的', productSequence: null },
    { productName: '有序号的', productSequence: 900 },
  ])
  assert.deepEqual(names(out), ['有序号的', '没序号的'])
})

test('没有 sequence 的彼此之间按商品名 A→Z —— 这是那 18.4% 的行不再随机的关键', () => {
  const out = sortLinesBySequence([
    { productName: 'Water Melon', productSequence: null },
    { productName: 'Beansprout', productSequence: undefined },
    { productName: 'Mushroom', productSequence: null },
  ])
  assert.deepEqual(names(out), ['Beansprout', 'Mushroom', 'Water Melon'])
})

test('sequence 相同的也按商品名排，不留随机余地', () => {
  const out = sortLinesBySequence([
    { productName: 'Zucchini', productSequence: 1330 },
    { productName: 'Apple', productSequence: 1330 },
  ])
  assert.deepEqual(names(out), ['Apple', 'Zucchini'])
})

test('同名同序号时保持原有相对顺序（稳定排序）', () => {
  const out = sortLinesBySequence([
    { productName: 'Same', productSequence: 10, tag: 'first' },
    { productName: 'Same', productSequence: 10, tag: 'second' },
  ])
  assert.deepEqual(out.map(r => r.tag), ['first', 'second'])
})

test('不修改传入数组', () => {
  const input = [
    { productName: 'B', productSequence: 2 },
    { productName: 'A', productSequence: 1 },
  ]
  const out = sortLinesBySequence(input)
  assert.deepEqual(names(input), ['B', 'A'], '原数组被就地改了')
  assert.notEqual(out, input)
})

test('空数组与缺字段不炸', () => {
  assert.deepEqual(sortLinesBySequence([]), [])
  const out = sortLinesBySequence([{ productName: '', productSequence: null }, {} as never])
  assert.equal(out.length, 2)
})

test('sequence 为 0 是有效值，不能当成"没有"', () => {
  const out = sortLinesBySequence([
    { productName: '没序号', productSequence: null },
    { productName: '零号', productSequence: 0 },
  ])
  assert.deepEqual(names(out), ['零号', '没序号'])
})

/**
 * 装货顺序排序（客户 2026-09-14 要求：送货单/发票/销售单/签收单四类客户单据改用它）。
 * 主键是 uomSequence（ProductSaleUom.sequence），打平时退回商品 sequence→商品名，
 * 跟 sortLinesBySequence 是同一套"没有排最后"规则叠了一层。
 */
test('装货顺序：有 uomSequence 的按升序', () => {
  const out = sortLinesByUomSequence([
    { productName: 'C', uomSequence: 3, productSequence: null },
    { productName: 'A', uomSequence: 1, productSequence: null },
    { productName: 'B', uomSequence: 2, productSequence: null },
  ])
  assert.deepEqual(names(out), ['A', 'B', 'C'])
})

test('装货顺序：没有 uomSequence 的排在最后，不当成 0', () => {
  const out = sortLinesByUomSequence([
    { productName: '没装货顺序', uomSequence: null, productSequence: null },
    { productName: '有装货顺序', uomSequence: 5, productSequence: null },
  ])
  assert.deepEqual(names(out), ['有装货顺序', '没装货顺序'])
})

test('装货顺序：uomSequence 打平时按商品 sequence 排（次级键）', () => {
  const out = sortLinesByUomSequence([
    { productName: 'Z', uomSequence: 1, productSequence: 200 },
    { productName: 'A', uomSequence: 1, productSequence: 100 },
  ])
  assert.deepEqual(names(out), ['A', 'Z'])
})

test('装货顺序：uomSequence 与商品 sequence 都打平时按商品名排', () => {
  const out = sortLinesByUomSequence([
    { productName: 'Zucchini', uomSequence: 1, productSequence: 100 },
    { productName: 'Apple', uomSequence: 1, productSequence: 100 },
  ])
  assert.deepEqual(names(out), ['Apple', 'Zucchini'])
})

test('装货顺序：uomSequence 为 0 是有效值，排在没有值的前面', () => {
  const out = sortLinesByUomSequence([
    { productName: '没装货顺序', uomSequence: null, productSequence: null },
    { productName: '零号', uomSequence: 0, productSequence: null },
  ])
  assert.deepEqual(names(out), ['零号', '没装货顺序'])
})
