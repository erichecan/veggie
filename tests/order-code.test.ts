/**
 * 回归测试：订单编码前缀永远是 ASCII（不再出现中文），中文名回退用 email 前缀。
 * bug: 创建者名"运营主管"→ getInitials 取前两中文字"运营"→ 订单码含中文→条形码/编码问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getInitials } from '../lib/order-code'

test('ASCII 姓名 → 首末首字母', () => {
  assert.equal(getInitials('Xiaohui Weng'), 'XW')
  assert.equal(getInitials('Xiaohui Weng(Evelyn)'), 'XW')
  assert.equal(getInitials('Edwin'), 'ED')
})

test('中文名 + email → 用 email 前缀', () => {
  assert.equal(getInitials('运营主管', 'operator@veggie.com'), 'OP')
  assert.equal(getInitials('老板', 'boss@veggie.com'), 'BO')
  assert.equal(getInitials('李老板 - 川味居', 'restaurant2@veggie.com'), 'RE')
})

test('中文名无 email → 兜底 NA，绝不返回中文', () => {
  const r = getInitials('运营主管')
  assert.equal(r, 'NA')
  assert.match(r, /^[A-Z0-9]{2}$/)
})

test('输出恒为 2 位 ASCII', () => {
  for (const [n, e] of [['运营', 'a@b.com'], ['张三', ''], ['', ''], ['A', '']] as const) {
    assert.match(getInitials(n, e), /^[A-Z0-9]{2}$/)
  }
})
