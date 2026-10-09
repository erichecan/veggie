import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userPickerOptions } from '../lib/user-picker'

// 20261009：Xuan Li 有一个停用的 placeholder 账号，Salesperson 下拉里出现两个「Xuan Li」
const users = [
  { id: 'old', name: 'Xuan Li', isActive: false },
  { id: 'new', name: 'Xuan Li', isActive: true },
  { id: 'h', name: 'Hong Xia' },
]

test('选人下拉只列启用账号', () => {
  assert.deepEqual(userPickerOptions(users, '', false).map(o => o.value), ['new', 'h'])
})

test('当前已选的停用账号保留并标注，已有数据不会显示成空白', () => {
  const opts = userPickerOptions(users, 'old', false)
  assert.deepEqual(opts.map(o => o.value), ['old', 'new', 'h'])
  assert.equal(opts[0].label, 'Xuan Li (已停用)')
  assert.equal(userPickerOptions(users, 'old', true)[0].label, 'Xuan Li (deactivated)')
})

test('报表筛选可以包含停用账号，但同名的分得开', () => {
  const opts = userPickerOptions(users, '', false, { includeInactive: true })
  assert.deepEqual(opts.map(o => o.label), ['Xuan Li (已停用)', 'Xuan Li', 'Hong Xia'])
})
